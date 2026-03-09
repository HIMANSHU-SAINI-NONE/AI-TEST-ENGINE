// ─── Test Generator Module ────────────────────────────────────────────
// Generates Vitest unit tests for exported functions using a local LLaMA model.

import * as fs from 'fs';
import * as path from 'path';
import { ScannedFunction, ExistingTest, GeneratedTest, EngineError } from './types';

const LLAMA_ENDPOINT = process.env.LLAMA_ENDPOINT ?? 'http://localhost:11434/api/generate';
const LLAMA_MODEL = process.env.LLAMA_MODEL ?? 'llama3:latest';
const GENERATED_DIR = '__generated_tests__';

/**
 * Build a deterministic prompt for the LLM to generate a Vitest test.
 */
function buildPrompt(fn: ScannedFunction, importPath: string): string {
    return `You are a test engineer. Write a Vitest unit test for the following TypeScript/JavaScript function.

FUNCTION NAME: ${fn.functionName}
FILE PATH: ${fn.filePath}
IMPORT PATH: ${importPath}

FUNCTION CODE:
\`\`\`
${fn.functionCode}
\`\`\`

REQUIREMENTS:
- Use Vitest syntax (import { describe, it, expect } from 'vitest')
- Import the function using: import { ${fn.functionName} } from '${importPath}'
- Include at least one normal case test
- Include at least one edge case test
- Do NOT use complex mocks
- Do NOT use fake data generators
- Do NOT use external dependencies
- Output ONLY the TypeScript test code
- Do NOT include any markdown formatting, explanations, or comments outside the code
- Do NOT wrap the code in markdown code fences`;
}

/**
 * Strip markdown code fences from LLM output if present.
 */
function stripMarkdownFences(code: string): string {
    let cleaned = code.trim();

    // Remove opening fence: ```typescript, ```ts, ```javascript, ```js, ```
    cleaned = cleaned.replace(/^```(?:typescript|ts|javascript|js)?\s*\n?/i, '');

    // Remove closing fence
    cleaned = cleaned.replace(/\n?```\s*$/i, '');

    return cleaned.trim();
}

/**
 * Call the local LLaMA model via Ollama API.
 */
async function callLlama(prompt: string): Promise<string> {
    const response = await fetch(LLAMA_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: LLAMA_MODEL,
            prompt,
            stream: false,
            options: {
                temperature: 0.2,
                num_predict: 2048,
            },
        }),
    });

    if (!response.ok) {
        throw new EngineError(
            'test-generation',
            `LLaMA API returned status ${response.status}: ${response.statusText}`
        );
    }

    const data = (await response.json()) as { response?: string };

    if (!data.response || data.response.trim().length === 0) {
        throw new EngineError('test-generation', 'LLaMA returned empty response.');
    }

    return stripMarkdownFences(data.response);
}

/**
 * Compute the relative import path from the generated test file to the source file.
 */
function computeImportPath(projectDir: string, sourceFilePath: string): string {
    const generatedDir = path.join(projectDir, GENERATED_DIR);
    let rel = path.relative(generatedDir, sourceFilePath);
    // Normalize to forward slashes for import
    rel = rel.replace(/\\/g, '/');
    // Remove extension
    rel = rel.replace(/\.(ts|js|tsx|jsx)$/, '');
    // Ensure relative prefix
    if (!rel.startsWith('.')) {
        rel = './' + rel;
    }
    return rel;
}

/**
 * Determine a unique test file name that doesn't collide with existing tests.
 */
function getUniqueTestFileName(
    functionName: string,
    existingTestFiles: Set<string>,
    generatedDir: string
): string {
    let candidate = `${functionName}.test.ts`;
    let counter = 1;

    while (
        existingTestFiles.has(candidate) ||
        fs.existsSync(path.join(generatedDir, candidate))
    ) {
        candidate = `${functionName}_${counter}.test.ts`;
        counter++;
    }

    return candidate;
}

/**
 * Generate a unit test for a single exported function.
 */
export async function generateTestForFunction(
    fn: ScannedFunction,
    projectDir: string,
    existingTests: ExistingTest[]
): Promise<GeneratedTest> {
    const generatedDir = path.join(projectDir, GENERATED_DIR);

    // Ensure generated tests directory exists
    if (!fs.existsSync(generatedDir)) {
        fs.mkdirSync(generatedDir, { recursive: true });
    }

    // Build set of existing test file names for duplicate avoidance
    const existingTestNames = new Set(existingTests.map((t) => t.fileName));

    const importPath = computeImportPath(projectDir, fn.filePath);
    const prompt = buildPrompt(fn, importPath);

    const testCode = await callLlama(prompt);

    // Basic validation: must contain 'import' and 'describe' or 'it' or 'test'
    if (!testCode.includes('import') || !(testCode.includes('describe') || testCode.includes('it(') || testCode.includes('test('))) {
        throw new EngineError(
            'test-generation',
            `LLaMA returned invalid test code for function "${fn.functionName}". Output does not appear to be valid Vitest code.`
        );
    }

    const testFileName = getUniqueTestFileName(fn.functionName, existingTestNames, generatedDir);
    const testFilePath = path.join(generatedDir, testFileName);

    fs.writeFileSync(testFilePath, testCode, 'utf-8');

    return {
        functionName: fn.functionName,
        testFilePath,
        testCode,
    };
}

/**
 * Generate unit tests for all scanned functions.
 */
export async function generateAllTests(
    functions: ScannedFunction[],
    projectDir: string,
    existingTests: ExistingTest[]
): Promise<GeneratedTest[]> {
    const results: GeneratedTest[] = [];

    for (const fn of functions) {
        const generated = await generateTestForFunction(fn, projectDir, existingTests);
        results.push(generated);
    }

    return results;
}
