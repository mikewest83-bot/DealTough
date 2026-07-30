import { PrismaClient } from "@prisma/client";
import { env } from "./env.js";

let prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!prisma) {
    env.databaseUrl(); // throws a clear error before Prisma's own less-clear one
    prisma = new PrismaClient();
  }
  return prisma;
}
