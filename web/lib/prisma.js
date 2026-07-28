const { PrismaClient } = require('@prisma/client');

// Cache the client across invocations in the same serverless instance —
// without this, each hot invocation could open a fresh DB connection and
// exhaust the connection pool.
const globalForPrisma = globalThis;

const prisma = globalForPrisma.__influencePrisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.__influencePrisma = prisma;

module.exports = { prisma };
