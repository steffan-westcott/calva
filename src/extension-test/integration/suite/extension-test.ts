import * as assert from 'assert';
import { expect } from 'chai';
import { after } from 'mocha';
import * as path from 'path';
import * as testUtil from './util';
import * as state from '../../../state';
import * as util from '../../../utilities';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
// import * as myExtension from '../extension';
import * as outputWindow from '../../../results-output/results-doc';
import { commands } from 'vscode';
import { getDocument } from '../../../doc-mirror';

vscode.window.showInformationMessage('Tests running. Yay!');

suite('Extension Test Suite', () => {
    after(() => {
        vscode.window.showInformationMessage('All tests done!');
    });

    // test("We have a context", async () => {
    //   const context = calvaState.extensionContext; // Makes things croak with message "state.config is not a function"
    //   expect(context).not.undefined("foo");
    //   context.workspaceState.get('selectedCljTypeName')
    // });

    test('Sample test', async () => {
        await sleep(1000);
        assert.equal(-1, [1, 2, 3].indexOf(5));
        assert.equal(-1, [1, 2, 3].indexOf(0));
    });

    // test("open a file and close it again, w/o croaking", async () => {
    //   expect(vscode.window.activeTextEditor).undefined;
    //   const testClj = await openFile(path.join(util.testDataDir, 'test.clj'));
    //   vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    //   await sleep(1000);
    //   expect(vscode.window.activeTextEditor).undefined;
    // });

    test('connect to repl', async function () {
        await openFile(path.join(testUtil.testDataDir, 'test.clj'));
        const dir = await state.initProjectDir();
        const uri = state.getProjectRootUri();
        // qps = quickPickSingle
        const saveAs = `qps-${uri.toString()}/jack-in-type`;
        state.extensionContext.workspaceState.update(saveAs, 'deps.edn');
        assert.equal(
            state.extensionContext.workspaceState.get(saveAs),
            'deps.edn',
            'Picking option timed out'
        );

        const res = commands.executeCommand('calva.jackIn');
        while (
            !state.extensionContext.workspaceState.get(
                'askForConnectSequenceQuickPick'
            )
        ) {
            await sleep(200);
        }
        assert('picked option', 'Picking option timed out');

        await commands.executeCommand(
            'workbench.action.acceptSelectedQuickOpenItem'
        );

        await res;
        while (!util.getConnectedState()) {
            await sleep(500);
        }
        assert('connected to repl', 'Repl connection timed out');

        const resultsDoc = getDocument(await outputWindow.openResultsDoc());

        const testUri = path.join(testUtil.testDataDir, 'test.clj');
        await vscode.workspace.openTextDocument(testUri).then((doc) =>
            vscode.window.showTextDocument(doc, {
                preserveFocus: false,
            })
        );
        await commands.executeCommand('calva.loadFile');
        const reversedLines = resultsDoc.model.lineInputModel.lines.reverse();
        assert.deepEqual(
            ['', 'clj꞉test꞉> ', 'nil', 'bar', '; Evaluating file: test.clj'],
            reversedLines.slice(0, 5).map((v) => v.text)
        );
    });

    // TODO: Add more smoke tests for the extension
    // TODO: Start building integration test coverage
});

async function openFile(filePath: string) {
    const uri = vscode.Uri.file(filePath);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);

    await sleep(300);

    return editor;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
