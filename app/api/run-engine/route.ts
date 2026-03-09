// ─── API Route: Run Engine ────────────────────────────────────────────
// POST /api/run-engine
// Accepts multipart/form-data with a ZIP file, extracts it, runs the pipeline.

import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import AdmZip from 'adm-zip';
import { runPipeline } from '@/engine/orchestrator';

export const runtime = 'nodejs';

// Disable default body size limit — ZIP files can be large
export const dynamic = 'force-dynamic';

/**
 * Create a unique temporary directory for extracting uploads.
 */
function createTempDir(): string {
    const tmpBase = os.tmpdir();
    const dirName = `ai-test-engine-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const fullPath = path.join(tmpBase, dirName);
    fs.mkdirSync(fullPath, { recursive: true });
    return fullPath;
}

/**
 * Clean up a temp directory (best-effort).
 */
function cleanupDir(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // Best-effort cleanup — ignore errors
    }
}

/**
 * Find the actual project root inside the extracted directory.
 * ZIP files sometimes contain a single top-level folder with the project inside.
 */
function findProjectRoot(extractDir: string): string {
    const entries = fs.readdirSync(extractDir, { withFileTypes: true });

    // If there's a package.json directly here, this is the root
    if (entries.some((e) => e.isFile() && e.name === 'package.json')) {
        return extractDir;
    }

    // If there's exactly one directory, check inside it
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    if (dirs.length === 1) {
        const innerDir = path.join(extractDir, dirs[0].name);
        if (fs.existsSync(path.join(innerDir, 'package.json'))) {
            return innerDir;
        }
    }

    // Return the extract directory and let validation catch the error
    return extractDir;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
    let tempDir = '';

    try {
        // ─── Parse multipart form data ─────────────────────────────────
        const formData = await request.formData();
        const file = formData.get('file');

        if (!file || !(file instanceof Blob)) {
            return NextResponse.json(
                { error: 'No file uploaded. Please upload a ZIP file.', logs: [] },
                { status: 400 }
            );
        }

        // Validate file type (basic check)
        const fileName = (file as File).name ?? 'upload.zip';
        if (!fileName.endsWith('.zip')) {
            return NextResponse.json(
                { error: 'Invalid file type. Only ZIP files are accepted.', logs: [] },
                { status: 400 }
            );
        }

        // ─── Extract ZIP ───────────────────────────────────────────────
        tempDir = createTempDir();
        const buffer = Buffer.from(await file.arrayBuffer());

        let zip: AdmZip;
        try {
            zip = new AdmZip(buffer);
        } catch {
            cleanupDir(tempDir);
            return NextResponse.json(
                { error: 'Invalid ZIP file. Could not parse the uploaded file.', logs: [] },
                { status: 400 }
            );
        }

        zip.extractAllTo(tempDir, true);

        // Find the actual project root (handles nested folders in ZIP)
        const projectDir = findProjectRoot(tempDir);

        // ─── Run pipeline ──────────────────────────────────────────────
        const result = await runPipeline(projectDir);

        return NextResponse.json(result, { status: 200 });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return NextResponse.json(
            { error: `Unexpected server error: ${message}`, logs: [] },
            { status: 500 }
        );
    } finally {
        // Best-effort cleanup
        if (tempDir) {
            cleanupDir(tempDir);
        }
    }
}
