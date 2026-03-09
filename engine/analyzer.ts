// ─── Analyzer Module ──────────────────────────────────────────────────
// Validates projects, scans source files, extracts exported functions,
// and detects existing tests using the TypeScript Compiler API.

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { ScannedFunction, ExistingTest, EngineError } from './types';

// ─── Ignored directories and test file patterns ─────────────────────

const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '__generated_tests__', '.next', '.git']);

const TEST_FILE_REGEX = /\.(test|spec)\.(ts|js|tsx|jsx)$/;

const SOURCE_EXTENSIONS = new Set(['.ts', '.js', '.tsx', '.jsx']);

// ─── Project Validation ─────────────────────────────────────────────

/**
 * Validates that a project directory has:
 * 1. A package.json file
 * 2. Vitest listed as a dependency or devDependency
 */
export async function validateProject(projectDir: string): Promise<void> {
    const packageJsonPath = path.join(projectDir, 'package.json');

    if (!fs.existsSync(packageJsonPath)) {
        throw new EngineError('validation', `package.json not found in project root: ${projectDir}`);
    }

    const raw = fs.readFileSync(packageJsonPath, 'utf-8');
    let packageJson: Record<string, unknown>;

    try {
        packageJson = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        throw new EngineError('validation', 'package.json is not valid JSON.');
    }

    const deps = (packageJson['dependencies'] ?? {}) as Record<string, string>;
    const devDeps = (packageJson['devDependencies'] ?? {}) as Record<string, string>;

    const hasVitest = 'vitest' in deps || 'vitest' in devDeps;

    if (!hasVitest) {
        throw new EngineError(
            'validation',
            'Vitest is not listed in dependencies or devDependencies. Please install Vitest in your project before uploading.'
        );
    }
}

// ─── Source File Scanning ────────────────────────────────────────────

/**
 * Recursively collects all source files (.ts, .js) from a project directory,
 * ignoring node_modules, dist, build, coverage directories, and test files.
 */
export async function scanSourceFiles(projectDir: string): Promise<string[]> {
    const results: string[] = [];

    function walk(dir: string): void {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!IGNORED_DIRS.has(entry.name)) {
                    walk(path.join(dir, entry.name));
                }
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name);
                if (SOURCE_EXTENSIONS.has(ext) && !TEST_FILE_REGEX.test(entry.name)) {
                    results.push(path.join(dir, entry.name));
                }
            }
        }
    }

    walk(projectDir);
    return results;
}

// ─── Exported Function Extraction (AST) ─────────────────────────────

/**
 * Parses a TypeScript/JavaScript file using the TS Compiler API and
 * extracts all exported function declarations and exported const arrow functions.
 */
export async function extractExportedFunctions(filePath: string): Promise<ScannedFunction[]> {
    const sourceText = fs.readFileSync(filePath, 'utf-8');
    const sourceFile = ts.createSourceFile(
        path.basename(filePath),
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    );

    const functions: ScannedFunction[] = [];

    function visit(node: ts.Node): void {
        // Exported function declaration: export function foo() { ... }
        if (
            ts.isFunctionDeclaration(node) &&
            node.name &&
            hasExportModifier(node)
        ) {
            functions.push({
                filePath,
                functionName: node.name.text,
                functionCode: sourceText.substring(node.pos, node.end).trim(),
            });
        }

        // Exported const arrow function: export const foo = (...) => { ... }
        if (
            ts.isVariableStatement(node) &&
            hasExportModifier(node)
        ) {
            for (const decl of node.declarationList.declarations) {
                if (
                    ts.isIdentifier(decl.name) &&
                    decl.initializer &&
                    (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
                ) {
                    functions.push({
                        filePath,
                        functionName: decl.name.text,
                        functionCode: sourceText.substring(node.pos, node.end).trim(),
                    });
                }
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return functions;
}

/**
 * Check if a node has the `export` keyword modifier.
 */
function hasExportModifier(node: ts.Node): boolean {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

// ─── Existing Test Detection ─────────────────────────────────────────

/**
 * Finds all existing test files (*.test.*, *.spec.*) in the project,
 * excluding node_modules and other ignored directories.
 */
export async function detectExistingTests(projectDir: string): Promise<ExistingTest[]> {
    const tests: ExistingTest[] = [];

    function walk(dir: string): void {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!IGNORED_DIRS.has(entry.name)) {
                    walk(path.join(dir, entry.name));
                }
            } else if (entry.isFile() && TEST_FILE_REGEX.test(entry.name)) {
                tests.push({
                    filePath: path.join(dir, entry.name),
                    fileName: entry.name,
                });
            }
        }
    }

    walk(projectDir);
    return tests;
}
