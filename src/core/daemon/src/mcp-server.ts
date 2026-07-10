import http from "http";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CLIENT_VERSION } from "@checkpointvcs/common";
import { Logger } from "./logging.js";
import { DaemonConfig } from "./daemon-config.js";
import { DaemonManager } from "./daemon-manager.js";

export interface McpStatus {
  /** Whether the MCP server is enabled in daemon.json */
  enabled: boolean;
  /** Whether the MCP server is currently accepting connections */
  running: boolean;
  port: number;
  /** Streamable HTTP endpoint URL when running */
  url: string | null;
  lastError: string | null;
}

interface McpToolEntry {
  /** MCP tool name, e.g. "workspaces_sync_pull" */
  name: string;
  /** tRPC procedure path, e.g. "workspaces.sync.pull" */
  path: string;
  description: string;
  inputSchema: object;
}

/**
 * Converts a tRPC procedure's zod input schema to a JSON schema for the MCP
 * tool listing. MCP requires an object-typed schema, so anything else (no
 * input, z.void(), unrepresentable types) falls back to a permissive object.
 */
function inputJsonSchema(procedure: any): object {
  const input = procedure._def?.inputs?.[0];
  if (!input) {
    return { type: "object", properties: {} };
  }

  try {
    const schema = z.toJSONSchema(input, {
      io: "input",
      unrepresentable: "any",
    }) as Record<string, unknown>;

    if (schema["type"] !== "object") {
      return { type: "object", properties: {} };
    }

    delete schema["$schema"];
    return schema;
  } catch {
    return { type: "object" };
  }
}

/**
 * McpManager runs an opt-in MCP (Model Context Protocol) server that exposes
 * every procedure of the daemon's tRPC API as an MCP tool. Tools are
 * auto-generated from the router definition, so new daemon API features are
 * available over MCP without extra wiring.
 *
 * Transport is Streamable HTTP (stateless mode) bound to 127.0.0.1 on the
 * port from daemon.json's `mcp.port` (default 13011), at path /mcp.
 */
export class McpManager {
  private static instance: McpManager | null = null;

  private httpServer: http.Server | null = null;
  private port = 0;
  private lastError: string | null = null;

  private tools: McpToolEntry[] | null = null;
  private createCaller: ((ctx: { manager: DaemonManager }) => any) | null =
    null;

  public static Get(): McpManager {
    if (!McpManager.instance) {
      McpManager.instance = new McpManager();
    }
    return McpManager.instance;
  }

  public async getStatus(): Promise<McpStatus> {
    const config = await DaemonConfig.Get();
    const running = this.httpServer !== null;
    const port = running ? this.port : (config.mcp?.port ?? 13011);

    return {
      enabled: config.mcp?.enabled ?? false,
      running,
      port,
      url: running ? `http://127.0.0.1:${port}/mcp` : null,
      lastError: this.lastError,
    };
  }

  public async start(): Promise<void> {
    if (this.httpServer) {
      return;
    }

    const config = await DaemonConfig.Get();
    const port = config.mcp?.port ?? 13011;

    try {
      await this.ensureTools();

      const server = http.createServer((req, res) => {
        void this.handleHttpRequest(req, res);
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.removeAllListeners("error");
          resolve();
        });
      });

      server.on("error", (err) => {
        Logger.error(`MCP server error: ${err.message}`);
        this.lastError = err.message;
      });

      this.httpServer = server;
      this.port = port;
      this.lastError = null;

      Logger.info(`MCP server listening on http://127.0.0.1:${port}/mcp`);
    } catch (e: any) {
      this.lastError = e?.message ?? String(e);
      Logger.error(`Failed to start MCP server: ${this.lastError}`);
      throw e;
    }
  }

  public async stop(): Promise<void> {
    const server = this.httpServer;
    if (!server) {
      return;
    }

    this.httpServer = null;

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Sever any open keep-alive/SSE connections so close() can finish.
      server.closeAllConnections();
    });

    Logger.info("MCP server stopped");
  }

  /**
   * Builds the MCP tool list from the tRPC app router. Imported dynamically
   * to avoid a static import cycle (api/index -> routers/mcp -> mcp-server).
   */
  private async ensureTools(): Promise<void> {
    if (this.tools && this.createCaller) {
      return;
    }

    const api = await import("./api/index.js");
    this.createCaller = api.createCaller;

    const procedures: Record<string, any> = (api.appRouter as any)._def
      .procedures;

    const tools: McpToolEntry[] = [];
    for (const [path, procedure] of Object.entries(procedures)) {
      const type: string = procedure._def?.type ?? "query";
      if (type === "subscription") {
        continue;
      }

      tools.push({
        name: path.replace(/\./g, "_"),
        path,
        description:
          `Calls the Checkpoint daemon's "${path}" ${type} procedure. ` +
          (type === "mutation"
            ? "This modifies daemon state."
            : "This is a read-only query."),
        inputSchema: inputJsonSchema(procedure),
      });
    }

    this.tools = tools;
  }

  private buildMcpServer(): Server {
    const server = new Server(
      { name: "checkpoint-daemon", version: CLIENT_VERSION || "0.0.0-dev" },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: (this.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = (this.tools ?? []).find(
        (t) => t.name === request.params.name,
      );
      if (!tool) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Unknown tool: ${request.params.name}` },
          ],
        };
      }

      try {
        const caller = this.createCaller!({ manager: DaemonManager.Get() });
        let fn: any = caller;
        for (const segment of tool.path.split(".")) {
          fn = fn[segment];
        }

        const result = await fn(request.params.arguments ?? {});

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result ?? null, null, 2),
            },
          ],
        };
      } catch (e: any) {
        return {
          isError: true,
          content: [{ type: "text", text: e?.message ?? String(e) }],
        };
      }
    });

    return server;
  }

  private async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    if (url.pathname !== "/mcp" && url.pathname !== "/") {
      res.writeHead(404, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Not found; use /mcp" },
          id: null,
        }),
      );
      return;
    }

    if (req.method !== "POST") {
      // Stateless mode: no SSE stream or session to GET/DELETE.
      res.writeHead(405, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed" },
          id: null,
        }),
      );
      return;
    }

    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

      // Stateless: a fresh server + transport per request so concurrent
      // clients never share state and no session bookkeeping is needed.
      const mcpServer = this.buildMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on("close", () => {
        void transport.close();
        void mcpServer.close();
      });

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e: any) {
      Logger.error(`MCP request failed: ${e?.message ?? e}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
    }
  }
}
