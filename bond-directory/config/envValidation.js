/**
 * Environment Variable Validation — Bond Directory
 *
 * Validates all required environment variables at startup.
 * Fails fast with clear error messages if any are missing.
 */

'use strict';

const { z } = require('zod');

const envSchema = z.object({
    PORT: z.coerce.number().int().min(1).max(65535).default(5050),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    // Bond Directory Database
    BOND_MONGO_URI: z.string().startsWith('mongodb').optional(),
    BOND_COLLECTION_NAME: z.string().min(1).default('bondsdirectory'),

    // CORS
    CORS_ORIGINS: z.string().optional(),

    // NSDL Session Cookies (optional — only needed for ETL sync)
    NSDL_JSESSIONID: z.string().optional(),
    NSDL_BIGipServerPool: z.string().optional(),

    // Bond Sync Schedule
    BOND_SYNC_SCHEDULE: z.string().optional(),
});

function validateEnv() {
    const result = envSchema.safeParse(process.env);

    if (!result.success) {
        console.error('\n╔══════════════════════════════════════════════════╗');
        console.error('║  ENVIRONMENT VALIDATION FAILED                   ║');
        console.error('╚══════════════════════════════════════════════════╝\n');

        result.error.issues.forEach(issue => {
            console.error(`  ✗ ${issue.path.join('.')}: ${issue.message}`);
        });

        console.error('\nFix the above errors in your .env file and restart.\n');
        process.exit(1);
    }

    return result.data;
}

module.exports = { validateEnv, envSchema };
