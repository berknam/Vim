import * as vscode from 'vscode';
import * as token from '../token';
import { TextEditor } from '../../textEditor';

import * as node from '../node';
import { VimState } from '../../state/vimState';
import { tokenizeKeySequence } from '../../util/specialKeys';
import { getAndUpdateModeHandler } from '../../../extension';
import { Mode } from '../../mode/mode';
import { RecordedState } from '../../state/recordedState';

export interface INormalCommandArguments extends node.ICommandArgs {
  bang?: boolean;
  keystrokes?: string;
}

//
// Implements :put
// http://vimdoc.sourceforge.net/htmldoc/change.html#:put
//

export class NormalCommand extends node.CommandBase {
  protected _arguments: INormalCommandArguments;

  constructor(args: INormalCommandArguments) {
    super();
    this._arguments = args;
  }

  get arguments(): INormalCommandArguments {
    return this._arguments;
  }

  public neovimCapable(): boolean {
    return true;
  }

  // async doPut(vimState: VimState, position: Position) {
  //   const registerName = this.arguments.register || (configuration.useSystemClipboard ? '*' : '"');
  //   vimState.recordedState.registerName = registerName;

  //   let options: IPutCommandOptions = {
  //     forceLinewise: true,
  //     forceCursorLastLine: true,
  //     after: this.arguments.bang,
  //   };

  //   await new PutCommand().exec(position, vimState, options);
  // }
  async doNormal(vimState: VimState) {
    const modeHandler = await getAndUpdateModeHandler(false);

    if (modeHandler && this.arguments.keystrokes) {
      await vimState.setCurrentMode(Mode.Normal);
      let previousRS = vimState.recordedState.clone();
      vimState.recordedState = new RecordedState();
      // vimState.recordedState.resetCommandList();
      // vimState.recordedState.actionKeys = [];
      vimState.recordedState.executingNormal = true;
      await modeHandler.handleMultipleKeyEvents(tokenizeKeySequence(this.arguments.keystrokes));
      vimState.recordedState = previousRS;
      vimState.recordedState.executingNormal = false;
    }
  }

  async execute(vimState: VimState): Promise<void> {
    // await this.doPut(vimState, vimState.cursorStopPosition);
    await this.doNormal(vimState);
  }

  async executeWithRange(vimState: VimState, range: node.LineRange): Promise<void> {
    let start: vscode.Position;
    let end: vscode.Position;

    if (range.left[0].type === token.TokenType.Percent) {
      start = new vscode.Position(0, 0);
      end = new vscode.Position(TextEditor.getLineCount() - 1, 0);
    } else {
      start = range.lineRefToPosition(vimState.editor, range.left, vimState);
      if (range.right.length === 0) {
        end = start;
      } else {
        end = range.lineRefToPosition(vimState.editor, range.right, vimState);
      }
    }
    for (let line = start.line; line <= end.line && line <= TextEditor.getLineCount(); line++) {
      vimState.editor.selection = new vscode.Selection(
        new vscode.Position(line, 0),
        new vscode.Position(line, 0)
      );
      await this.doNormal(vimState);
    }
  }
}
