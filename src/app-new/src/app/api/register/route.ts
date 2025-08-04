import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "crypto";
import { db } from "~/server/db";
import { computePasswordHash } from "~/server/auth/credentials";

const registerSchema = z.object({
  username: z.string().min(1, "Username is required").max(50, "Username too long"),
  email: z.string().email("Invalid email format"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().min(1, "Name is required").max(100, "Name too long"),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as unknown;
    const validatedData = registerSchema.parse(body);

    // Check if username already exists
    const existingUser = await db.user.findFirst({
      where: {
        OR: [
          { username: validatedData.username },
          { email: validatedData.email },
        ],
      },
    });

    if (existingUser) {
      return NextResponse.json(
        {
          error: existingUser.username === validatedData.username
            ? "Username already exists"
            : "Email already exists"
        },
        { status: 409 }
      );
    }

    // Generate a globally unique salt
    const salt = randomBytes(32).toString("hex");

    // Hash the password with the salt
    const hash = await computePasswordHash(validatedData.password, salt);

    // Create the user
    const user = await db.user.create({
      data: {
        username: validatedData.username,
        email: validatedData.email,
        name: validatedData.name,
        salt,
        hash,
        checkpointAdmin: false,
      },
      select: {
        id: true,
        username: true,
        email: true,
        name: true,
        checkpointAdmin: true,
      },
    });

    return NextResponse.json({
      success: true,
      user,
      message: "User registered successfully",
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: "Validation failed",
          details: error.errors.map(e => ({ field: e.path.join('.'), message: e.message }))
        },
        { status: 400 }
      );
    }

    console.error("Registration error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
