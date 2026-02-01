import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getAIProvider } from './aiFactory';

import * as crypto from 'crypto';
import * as cp from 'child_process';
import { promisify } from 'util';

const exec = promisify(cp.exec);

import { SettingsTreeProvider } from './settingsView';

export function activate(context: vscode.ExtensionContext) {
    console.log('CodeStory AI extension is now active!');

    // Register Sidebar View
    const settingsProvider = new SettingsTreeProvider();
    vscode.window.registerTreeDataProvider('codestory-ai-settings', settingsProvider);

    // Commands
    context.subscriptions.push(vscode.commands.registerCommand('codestory-ai.refreshSettings', () => settingsProvider.refresh()));

    context.subscriptions.push(vscode.commands.registerCommand('codestory-ai.setProvider', async () => {
        const option = await vscode.window.showQuickPick(['vertex', 'ollama'], { placeHolder: 'Select AI Provider' });
        if (option) {
            await vscode.workspace.getConfiguration('codestory-ai').update('provider', option, vscode.ConfigurationTarget.Global);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('codestory-ai.setDocStyle', async () => {
        const option = await vscode.window.showQuickPick(['simple', 'concise', 'explained', 'detailed'], { placeHolder: 'Select Documentation Style' });
        if (option) {
            await vscode.workspace.getConfiguration('codestory-ai').update('docStyle', option, vscode.ConfigurationTarget.Global);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('codestory-ai.setOllamaModel', async () => {
        const value = await vscode.window.showInputBox({ prompt: 'Enter Ollama Model Name', placeHolder: 'e.g., llama3, mistral' });
        if (value) {
            await vscode.workspace.getConfiguration('codestory-ai').update('ollamaModel', value, vscode.ConfigurationTarget.Global);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('codestory-ai.setProjectId', async () => {
        const value = await vscode.window.showInputBox({ prompt: 'Enter Vertex AI Project ID' });
        if (value) {
            await vscode.workspace.getConfiguration('codestory-ai').update('projectId', value, vscode.ConfigurationTarget.Global);
        }
    }));

    // About Command
    context.subscriptions.push(vscode.commands.registerCommand('codestory-ai.about', () => {
        vscode.window.showInformationMessage(
            "CodeStory AI is built by Animesh Gupta (@agupta07505).",
            "View GitHub Profile",
            "Connect on LinkedIn"
        ).then(selection => {
            if (selection === "View GitHub Profile") {
                vscode.env.openExternal(vscode.Uri.parse("https://github.com/agupta07505"));
            } else if (selection === "Connect on LinkedIn") {
                vscode.env.openExternal(vscode.Uri.parse("https://linkedin.com/in/agupta07505"));
            }
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('codestory-ai.toggleEnabled', async () => {
        const config = vscode.workspace.getConfiguration('codestory-ai');
        const current = config.get<boolean>('enabled', true);
        await config.update('enabled', !current, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`CodeStory AI is now ${!current ? 'Enabled' : 'Disabled'}`);
        settingsProvider.refresh();
    }));

    // Cache for file hashes
    const fileHashes = new Map<string, string>();

    const disposable = vscode.workspace.onDidSaveTextDocument(async (document: vscode.TextDocument) => {
        const config = vscode.workspace.getConfiguration('codestory-ai');
        if (!config.get<boolean>('enabled', true)) {
            return;
        }

        if (document.uri.scheme !== 'file') {
            return;
        }

        // Avoid infinite loops
        if (path.basename(document.fileName).toLowerCase() === 'readme.md') {
            return;
        }

        // Exclusions
        const fileName = path.basename(document.fileName).toLowerCase();
        if (fileName === 'package.json' || fileName === 'package-lock.json' || fileName === 'tsconfig.json' || fileName.startsWith('.')) {
            return;
        }

        if (document.fileName.includes(path.sep + '.git') || document.fileName.includes(path.sep + 'node_modules') || document.fileName.includes(path.sep + 'out') || document.fileName.includes(path.sep + 'dist')) {
            return;
        }

        const code = document.getText();

        // Hashing optimization
        const hash = crypto.createHash('md5').update(code).digest('hex');
        if (fileHashes.get(document.fileName) === hash) {
            console.log("CodeStory AI: Content unchanged, skipping generation.");
            return;
        }

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "CodeStory AI: Generating documentation...",
                cancellable: false
            }, async (progress) => {
                const provider = getAIProvider();
                // Pass "concise" hint
                const docs = await provider.generate(code);

                // Update Hash
                fileHashes.set(document.fileName, hash);

                // Output to channel
                const outputChannel = vscode.window.createOutputChannel("CodeStory AI");
                outputChannel.show(true);
                outputChannel.appendLine("--- Generated Documentation ---");
                outputChannel.appendLine(docs);
                outputChannel.appendLine("-------------------------------");

                // Save to CodeStory AI Folder
                progress.report({ message: "Saving to CodeStory AI/..." });
                await saveToCodeStoryAIFolder(document, docs);

                vscode.window.showInformationMessage(`CodeStory AI: Saved to CodeStory AI/${path.basename(document.fileName, path.extname(document.fileName))}.md`);
            });

        } catch (error) {
            console.error('CodeStory AI Error:', error);
        }
    });

    context.subscriptions.push(disposable);

    // Startup Checks
    checkOllamaRequirements();
}

async function checkOllamaRequirements() {
    const config = vscode.workspace.getConfiguration('codestory-ai');
    const provider = config.get<string>('provider');
    const model = config.get<string>('ollamaModel', 'llama3');

    // Only exclude check if user explicitly set to vertex. Default is now ollama, so we check.
    if (provider === 'vertex') { return; }

    try {
        // Check if Ollama is installed
        await exec('ollama --version');

        // Check if model exists
        const { stdout } = await exec('ollama list');
        if (!stdout.includes(model)) {
            const val = await vscode.window.showWarningMessage(
                `CodeStory AI: The model '${model}' is not found in Ollama.`,
                'Download Model',
                'Cancel'
            );
            if (val === 'Download Model') {
                const terminal = vscode.window.createTerminal('CodeStory AI Setup');
                terminal.show();
                terminal.sendText(`ollama pull ${model}`);
            }
        }
    } catch (error) {
        // likely ollama not installed or not in path
        const val = await vscode.window.showErrorMessage(
            "CodeStory AI: Ollama is not detected! It is required for local documentation generation.",
            "Install Ollama",
            "Ignore"
        );
        if (val === 'Install Ollama') {
            vscode.env.openExternal(vscode.Uri.parse('https://ollama.com'));
        }
    }
}

async function saveToCodeStoryAIFolder(document: vscode.TextDocument, content: string) {
    if (!vscode.workspace.workspaceFolders) {
        return;
    }

    const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const folderPath = path.join(rootPath, 'CodeStory AI');

    // Create CodeStory AI folder if needed
    if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath);
    }

    const fileName = path.basename(document.fileName);
    const ext = path.extname(fileName); // e.g., .ts
    const baseName = path.basename(fileName, ext); // e.g., extension

    // Naming: (file name excluding extension) + .md
    // Example: extension.ts -> CodeStory AI/extension.md
    const mdFileName = `${baseName}.md`;
    const mdFilePath = path.join(folderPath, mdFileName);

    const fileContent = `# Documentation: ${fileName}\n\n**Source File**: \`${fileName}\`\n**Last Updated**: ${new Date().toLocaleString()}\n\n---\n\n${content}\n`;

    fs.writeFileSync(mdFilePath, fileContent);
}

export function deactivate() { }
