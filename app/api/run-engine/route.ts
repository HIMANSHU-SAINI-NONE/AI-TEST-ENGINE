// api route for running the engine
// POST /api/run-engine
// user uploads a zip file and we run tests on it

import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import AdmZip from 'adm-zip';
import { runPipeline } from '@/engine/orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROJECT_MARKERS: readonly string[] = [
    'package.json',
    'pyproject.toml',
    'pom.xml',
    'go.mod',
    'requirements.txt',
];

const IGNORED_ARCHIVE_DIRECTORIES: ReadonlySet<string> = new Set([
    '__MACOSX',
    'node_modules',
    '.git',
]);

// make a temp folder to extract the zip into
function makeTempFolder(): string {
    let tmpBase = os.tmpdir();
    let folderName = 'ai-test-engine-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
    let fullPath = path.join(tmpBase, folderName);
    fs.mkdirSync(fullPath, { recursive: true });
    console.log("created temp folder: " + fullPath);
    return fullPath;
}

// delete the temp folder when we're done
function deleteTempFolder(dir: string) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log("deleted temp folder: " + dir);
    } catch (e) {
        // its ok if this fails
        console.log("couldnt delete temp folder, oh well");
    }
}

// find where the actual project is inside the extracted zip
// sometimes zips have an extra folder wrapping everything
function findProjectFolder(extractDir: string): string {
    const queue: Array<{ dir: string; depth: number }> = [{ dir: extractDir, depth: 0 }];
    const maxDepth = 5;

    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) {
            break;
        }

        const hasMarker = PROJECT_MARKERS.some((marker: string) => fs.existsSync(path.join(current.dir, marker)));
        if (hasMarker) {
            return current.dir;
        }

        if (current.depth >= maxDepth) {
            continue;
        }

        let entries: fs.Dirent[] = [];
        try {
            entries = fs.readdirSync(current.dir, { withFileTypes: true });
        } catch {
            continue;
        }

        const childDirs = entries
            .filter((entry: fs.Dirent) => {
                if (!entry.isDirectory()) {
                    return false;
                }

                if (entry.name.startsWith('.')) {
                    return false;
                }

                return !IGNORED_ARCHIVE_DIRECTORIES.has(entry.name);
            })
            .map((entry: fs.Dirent) => entry.name)
            .sort((a: string, b: string) => a.localeCompare(b));

        for (const folderName of childDirs) {
            queue.push({
                dir: path.join(current.dir, folderName),
                depth: current.depth + 1,
            });
        }
    }

    // fallback to the extraction root if no known marker is found
    return extractDir;
}

// handle the POST request
export async function POST(request: NextRequest) {
    let tempDir = '';

    try {
        // get the file from the form data
        let formData = await request.formData();
        let file = formData.get('file');

        // check if file was uploaded
        if (!file || !(file instanceof Blob)) {
            return NextResponse.json(
                { error: 'No file uploaded. Please upload a ZIP file.', logs: [] },
                { status: 400 }
            );
        }

        // check if its a zip file
        let fileName = file instanceof File && file.name ? file.name : 'upload.zip';
        if (!fileName.endsWith('.zip')) {
            return NextResponse.json(
                { error: 'Invalid file type. Only ZIP files are accepted.', logs: [] },
                { status: 400 }
            );
        }

        // extract the zip file
        tempDir = makeTempFolder();
        let buffer = Buffer.from(await file.arrayBuffer());

        let zip: AdmZip;
        try {
            zip = new AdmZip(buffer);
        } catch {
            deleteTempFolder(tempDir);
            return NextResponse.json(
                { error: 'Invalid ZIP file. Could not parse the uploaded file.', logs: [] },
                { status: 400 }
            );
        }

        zip.extractAllTo(tempDir, true);
        console.log("extracted zip to: " + tempDir);

        // find the project root
        let projectDir = findProjectFolder(tempDir);

        // run the pipeline!
        console.log("running pipeline...");
        let result = await runPipeline(projectDir);

        return NextResponse.json(result, { status: 200 });
    } catch (error: unknown) {
        console.log("error in api route:", error);
        let message = error instanceof Error ? error.message : String(error);
        return NextResponse.json(
            { error: 'Unexpected server error: ' + message, logs: [] },
            { status: 500 }
        );
    } finally {
        // clean up temp folder
        if (tempDir != '') {
            deleteTempFolder(tempDir);
        }
    }
}
