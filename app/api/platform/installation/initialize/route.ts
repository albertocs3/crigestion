import { pbkdf2Sync, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const initializeSchema = z.object({
  company: z.object({
    legalName: z.string().min(2).max(200),
    taxId: z.string().min(3).max(32),
    email: z.string().email().optional()
  }),
  administrator: z.object({
    displayName: z.string().min(2).max(160),
    userName: z
      .string()
      .min(3)
      .max(80)
      .regex(
        /^[a-zA-Z0-9._-]+$/,
        "El usuario solo admite letras, numeros, punto, guion y guion bajo."
      ),
    password: z
      .string()
      .min(12)
      .max(200)
      .regex(/[a-z]/, "La contrasena debe incluir una minuscula.")
      .regex(/[A-Z]/, "La contrasena debe incluir una mayuscula.")
      .regex(/[0-9]/, "La contrasena debe incluir un numero.")
      .regex(/[^a-zA-Z0-9]/, "La contrasena debe incluir un caracter especial.")
  })
});

const platformPermissions = [
  ["Platform.ManageUsers", "Gestionar usuarios"],
  ["Platform.ManageRoles", "Gestionar roles"],
  ["Platform.ManageConfiguration", "Gestionar configuracion"],
  ["Platform.ViewAudit", "Consultar auditoria"]
] as const;

function normalizeUserName(userName: string) {
  return userName.trim().toLocaleLowerCase("es-ES");
}

function hashPassword(password: string) {
  const iterations = 210_000;
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");

  return `pbkdf2_sha256$${iterations}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function isAllowedOrigin(request: Request) {
  const origin = request.headers.get("Origin");
  const appBaseUrl = process.env.APP_BASE_URL;

  if (!origin || !appBaseUrl) {
    return true;
  }

  return origin === appBaseUrl;
}

export async function POST(request: Request) {
  if (!isAllowedOrigin(request)) {
    return NextResponse.json(
      {
        code: "ORIGIN_NOT_ALLOWED",
        message: "Origen no permitido."
      },
      { status: 403 }
    );
  }

  const contentType = request.headers.get("Content-Type") ?? "";

  if (!contentType.toLocaleLowerCase("en-US").includes("application/json")) {
    return NextResponse.json(
      {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "La peticion debe enviarse como JSON."
      },
      { status: 415 }
    );
  }

  const idempotencyKey = request.headers.get("Idempotency-Key");

  if (!idempotencyKey) {
    return NextResponse.json(
      {
        code: "IDEMPOTENCY_KEY_REQUIRED",
        message: "La cabecera Idempotency-Key es obligatoria."
      },
      { status: 400 }
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        code: "INVALID_JSON",
        message: "El cuerpo de la peticion no es JSON valido."
      },
      { status: 400 }
    );
  }

  const payload = initializeSchema.safeParse(body);

  if (!payload.success) {
    return NextResponse.json(
      {
        code: "VALIDATION_ERROR",
        issues: payload.error.flatten()
      },
      { status: 422 }
    );
  }

  const existing = await prisma.installation.findFirst();

  if (existing) {
    return NextResponse.json(
      {
        code: "PLATFORM_ALREADY_INITIALIZED",
        message: "La plataforma ya esta inicializada."
      },
      { status: 409 }
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const administratorRole = await tx.role.upsert({
      where: { code: "Administrador" },
      update: { name: "Administrador", isProtected: true },
      create: {
        code: "Administrador",
        name: "Administrador",
        isProtected: true
      }
    });

    for (const [code, name] of platformPermissions) {
      const permission = await tx.permission.upsert({
        where: { code },
        update: { name },
        create: { code, name }
      });

      await tx.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: administratorRole.id,
            permissionId: permission.id
          }
        },
        update: {},
        create: {
          roleId: administratorRole.id,
          permissionId: permission.id
        }
      });
    }

    const normalizedUserName = normalizeUserName(
      payload.data.administrator.userName
    );

    const company = await tx.company.create({
      data: payload.data.company
    });

    const administrator = await tx.user.create({
      data: {
        displayName: payload.data.administrator.displayName,
        userName: payload.data.administrator.userName,
        normalizedUserName,
        passwordHash: hashPassword(payload.data.administrator.password),
        status: "ACTIVE",
        roleId: administratorRole.id
      }
    });

    await tx.reservedUserName.create({
      data: {
        normalizedUserName,
        reservedByUserId: administrator.id,
        reason: "INITIAL_ADMINISTRATOR"
      }
    });

    const installation = await tx.installation.create({
      data: {
        status: "INITIALIZED",
        startedAt: new Date(),
        completedAt: new Date(),
        productVersion: "0.1.0",
        companyId: company.id,
        initialAdministratorId: administrator.id
      }
    });

    await tx.auditEvent.create({
      data: {
        eventType: "PLATFORM_INITIALIZED",
        actorType: "SYSTEM",
        payload: {
          companyId: company.id,
          administratorId: administrator.id,
          idempotencyKey
        }
      }
    });

    return installation;
  });

  return NextResponse.json(result, { status: 201 });
}
