// testGenerator.ts - uses llama AI to generate tests
// this is the coolest part of the project!!

import * as fs from 'fs';
import * as path from 'path';
import { ScannedFunction, ExistingTest, GeneratedTest, EngineError } from './types';

// where the llama api is running
let LLAMA_URL = process.env.LLAMA_ENDPOINT ?? 'http://localhost:11434/api/generate';
let LLAMA_MODEL = process.env.LLAMA_MODEL ?? 'llama3:latest';
let GENERATED_FOLDER = '__generated_tests__';

// make the prompt for the AI
function makePrompt(fn: ScannedFunction, importPath: string): string {
    let prompt = `You are a test engineer. Write a Vitest unit test for the following TypeScript/JavaScript function.

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
    return prompt;
}

// remove the ``` stuff from the AI response
function cleanUpCode(code: string): string {
    let cleaned = code.trim();

    // remove the opening ```
    if (cleaned.startsWith('```typescript') || cleaned.startsWith('```ts') || cleaned.startsWith('```javascript') || cleaned.startsWith('```js') || cleaned.startsWith('```')) {
        let firstNewline = cleaned.indexOf('\n');
        if (firstNewline !== -1) {
            cleaned = cleaned.substring(firstNewline + 1);
        } else {
            cleaned = cleaned.replace(/^```\w*/, '');
        }
    }

    // remove the closing ```
    if (cleaned.endsWith('```')) {
        cleaned = cleaned.substring(0, cleaned.length - 3);
    }

    return cleaned.trim();
}

// call the llama AI api
async function callLlama(prompt: string): Promise<string> {
    console.log("calling llama api...");

    let body = {
        model: LLAMA_MODEL,
        prompt: prompt,
        stream: false,
        options: {
            temperature: 0.2,
            num_predict: 2048,
        },
    };

    let response = await fetch(LLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        throw new EngineError(
            'test-generation',
            `LLaMA API returned status ${response.status}: ${response.statusText}`
        );
    }

    let data: any = await response.json();

    if (!data.response || data.response.trim().length == 0) {
        throw new EngineError('test-generation', 'LLaMA returned empty response.');
    }

    console.log("got response from llama!");
    return cleanUpCode(data.response);
}

// figure out the import path for the test file
function getImportPath(projectDir: string, sourceFilePath: string): string {
    let generatedDir = path.join(projectDir, GENERATED_FOLDER);
    let rel = path.relative(generatedDir, sourceFilePath);
    // fix windows backslashes
    rel = rel.split('\\').join('/');
    // remove the file extension
    rel = rel.replace(/\.(ts|js|tsx|jsx)$/, '');
    // add ./ if needed
    if (!rel.startsWith('.')) {
        rel = './' + rel;
    }
    return rel;
}

// get a unique name for the test file so we dont overwrite anything
function getTestFileName(
    functionName: string,
    existingTestFiles: string[],
    generatedDir: string
): string {
    let name = functionName + '.test.ts';
    let counter = 1;

    // keep trying until we find a name that doesnt exist
    let nameExists = true;
    while (nameExists) {
        nameExists = false;
        // check existing tests
        for (let i = 0; i < existingTestFiles.length; i++) {
            if (existingTestFiles[i] == name) {
                nameExists = true;
                break;
            }
        }
        // check if file already exists on disk
        if (fs.existsSync(path.join(generatedDir, name))) {
            nameExists = true;
        }
        if (nameExists) {
            name = functionName + '_' + counter + '.test.ts';
            counter = counter + 1;
        }
    }

    return name;
}

// generate a test for one function
export async function generateTestForFunction(
    fn: ScannedFunction,
    projectDir: string,
    existingTests: ExistingTest[]
): Promise<GeneratedTest> {
    let generatedDir = path.join(projectDir, GENERATED_FOLDER);

    // make the folder if it doesnt exist
    if (!fs.existsSync(generatedDir)) {
        fs.mkdirSync(generatedDir, { recursive: true });
    }

    // get list of existing test file names
    let existingNames: string[] = [];
    for (let i = 0; i < existingTests.length; i++) {
        existingNames.push(existingTests[i].fileName);
    }

    let importPath = getImportPath(projectDir, fn.filePath);
    let prompt = makePrompt(fn, importPath);

    let testCode = await callLlama(prompt);

    // check if the code looks valid
    let hasImport = testCode.includes('import');
    let hasTest = testCode.includes('describe') || testCode.includes('it(') || testCode.includes('test(');
    if (!hasImport || !hasTest) {
        throw new EngineError(
            'test-generation',
            `LLaMA returned invalid test code for function "${fn.functionName}". Output does not appear to be valid Vitest code.`
        );
    }

    let testFileName = getTestFileName(fn.functionName, existingNames, generatedDir);
    let testFilePath = path.join(generatedDir, testFileName);

    // write the test file
    fs.writeFileSync(testFilePath, testCode, 'utf-8');
    console.log("wrote test file: " + testFilePath);

    return {
        functionName: fn.functionName,
        testFilePath: testFilePath,
        testCode: testCode,
    };
}

// generate tests for ALL functions
export async function generateAllTests(
    functions: ScannedFunction[],
    projectDir: string,
    existingTests: ExistingTest[]
): Promise<GeneratedTest[]> {
    let results: GeneratedTest[] = [];

    for (let i = 0; i < functions.length; i++) {
        console.log("generating test " + (i + 1) + " of " + functions.length);
        let generated = await generateTestForFunction(functions[i], projectDir, existingTests);
        results.push(generated);
    }

    console.log("done generating all tests!");
    return results;
}
