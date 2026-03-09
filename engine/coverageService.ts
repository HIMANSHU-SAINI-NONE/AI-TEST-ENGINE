// ─── Coverage Service Module ──────────────────────────────────────────
// Parses Vitest/Istanbul coverage JSON output.

import * as fs from 'fs';
import * as path from 'path';
import { CoverageResult, EngineError } from './types';

/**
 * Structure of an Istanbul coverage entry for a single file.
 * Each key in statementMap is a statement ID.
 * The `s` object maps statement IDs to hit counts.
 */
interface IstanbulFileCoverage {
    s: Record<string, number>;
    statementMap: Record<string, unknown>;
}

/**
 * Parse the coverage-final.json (Istanbul format) and compute
 * total statement coverage across all files.
 */
export async function parseCoverage(projectDir: string): Promise<CoverageResult> {
    // Vitest writes coverage to ./coverage by default
    const coveragePath = path.join(projectDir, 'coverage', 'coverage-final.json');

    if (!fs.existsSync(coveragePath)) {
        throw new EngineError(
            'coverage',
            `Coverage file not found at: ${coveragePath}. Ensure Vitest is configured to produce coverage output (--coverage flag).`
        );
    }

    const raw = fs.readFileSync(coveragePath, 'utf-8');
    let coverageData: Record<string, IstanbulFileCoverage>;

    try {
        coverageData = JSON.parse(raw) as Record<string, IstanbulFileCoverage>;
    } catch {
        throw new EngineError('coverage', 'Failed to parse coverage JSON. File may be corrupted.');
    }

    let totalStatements = 0;
    let coveredStatements = 0;

    for (const filePath of Object.keys(coverageData)) {
        const fileCov = coverageData[filePath];

        if (!fileCov.s || !fileCov.statementMap) {
            continue;
        }

        for (const stmtId of Object.keys(fileCov.s)) {
            totalStatements++;
            if (fileCov.s[stmtId] > 0) {
                coveredStatements++;
            }
        }
    }

    const percentage = totalStatements > 0
        ? Math.round((coveredStatements / totalStatements) * 10000) / 100
        : 0;

    return {
        totalLines: totalStatements,
        coveredLines: coveredStatements,
        percentage,
    };
}
