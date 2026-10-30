import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";
import { themes } from "prism-react-renderer";

const config: Config = {
  title: "Checkpoint Documentation",
  tagline: "Version control for creative workflows",
  favicon: "favicon.ico",

  url: "https://checkpointvcs.com",
  baseUrl: "/",

  organizationName: "Incanta",
  projectName: "Checkpoint",

  onBrokenLinks: "throw",
  onBrokenMarkdownLinks: "warn",

  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "throw",
    },
  },

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: require.resolve("./sidebars.js"),
          editUrl:
            "https://github.com/Incanta/Checkpoint/tree/main/website/docusaurus/",
          sidebarCollapsed: true,
          sidebarCollapsible: true,
        },
        blog: {
          showReadingTime: true,
          editUrl:
            "https://github.com/Incanta/Checkpoint/tree/main/website/docusaurus/",
          blogSidebarCount: "ALL",
        },
        theme: {
          customCss: require.resolve("./src/css/custom.css"),
        },
        sitemap: {
          filename: "docusaurus-sitemap.xml",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: "img/checkpoint-social-card.png",
    announcementBar: {
      id: "public-beta",
      content:
        'Checkpoint is in public beta. Keep backups of your server, and <a href="/docs/getting-started/beta">tell us what you find</a>.',
      isCloseable: true,
    },
    navbar: {
      title: "Checkpoint",
      logo: {
        alt: "Checkpoint Logo",
        src: "img/logo.svg",
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "docsSidebar",
          position: "left",
          label: "Docs",
        },
        { to: "/blog", label: "Blog", position: "left" },
        {
          href: "https://checkpointvcs.com",
          label: "Home",
          position: "right",
        },
        {
          href: "https://github.com/Incanta/Checkpoint",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Docs",
          items: [
            {
              label: "Getting Started",
              to: "/docs/",
            },
            {
              label: "Quickstart",
              to: "/docs/quickstart",
            },
            {
              label: "Public Beta",
              to: "/docs/getting-started/beta",
            },
            {
              label: "Troubleshooting",
              to: "/docs/troubleshooting",
            },
          ],
        },
        {
          title: "Community",
          items: [
            {
              label: "GitHub",
              href: "https://github.com/Incanta/Checkpoint",
            },
            {
              label: "GitHub Discussions",
              href: "https://github.com/Incanta/Checkpoint/discussions",
            },
            {
              label: "Report a Bug",
              href: "https://github.com/Incanta/Checkpoint/issues",
            },
          ],
        },
        {
          title: "More",
          items: [
            {
              label: "Blog",
              to: "/blog",
            },
            {
              label: "Home",
              href: "https://checkpointvcs.com",
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Incanta. All rights reserved.`,
    },
    prism: {
      theme: themes.github,
      darkTheme: themes.dracula,
      additionalLanguages: [
        "bash",
        "diff",
        "json",
        "javascript",
        "typescript",
      ],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
