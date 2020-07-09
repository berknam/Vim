import * as vscode from 'vscode';

import { BaseMovement } from '../actions/baseMotion';
import { EasyMotion } from './../actions/plugins/easymotion/easymotion';
import { EditorIdentity } from './../editorIdentity';
import { HistoryTracker } from './../history/historyTracker';
import { InputMethodSwitcher } from '../actions/plugins/imswitcher';
import { Logger } from '../util/logger';
import { Mode, isVisualMode } from '../mode/mode';
import { Position } from './../common/motion/position';
import { Range } from './../common/motion/range';
import { RecordedState } from './recordedState';
import { RegisterMode } from './../register/register';
import { ReplaceState } from './../state/replaceState';
import { TextEditor } from '../textEditor';

interface INVim {
  run(vimState: VimState, command: string): Promise<{ statusBarText: string; error: boolean }>;

  dispose(): void;
}

/**
 * The VimState class holds permanent state that carries over from action
 * to action.
 *
 * Actions defined in actions.ts are only allowed to mutate a VimState in order to
 * indicate what they want to do.
 *
 * Each ModeHandler holds a VimState, so there is one for each open editor.
 */
export class VimState implements vscode.Disposable {
  private readonly logger = Logger.get('VimState');

  private _desiredColumn = 0;
  /**
   * The column the cursor wants to be at, or Number.POSITIVE_INFINITY if it should always
   * be the rightmost column.
   *
   * Example: If you go to the end of a 20 character column, this value
   * will be 20, even if you press j and the next column is only 5 characters.
   * This is because if the third column is 25 characters, the cursor will go
   * back to the 20th column.
   */
  public get desiredColumn(): number {
    return this._desiredColumn;
  }

  public ignoreNextSelectionChange: boolean = false;

  public async setDesiredColumn(value: number) {
    // const currentCursorColumn = this.cursorStopPosition.character;
    const currentCursorColumn = this.editor.selection.active.character;
    const currentLine = this.editor.selection.active.line;
    const currentSelections = this.editor.selections.slice(0);
    this.ignoreNextSelectionChange = true;
    await vscode.commands
      .executeCommand('cursorMove', {
        // to: 'up',
        to: 'wrappedLineStart',
        select: isVisualMode(this.currentMode),
        // by: 'wrappedLine',
        // value: 1,
      })
      .then(async () => {
        let rightMoveToCorrectPosition: number = 0;
        // const active = this.editor.selection.active;
        // if (active.character > 0) {
        //   // We were on a wrapped line so the left movement sent us to the end of the previous
        //   // line instead of sending us to the start of line.
        //   this._desiredColumn =
        //     currentCursorColumn -
        //     active.character +
        //     TextEditor.getFirstNonWhitespaceCharOnLine(active.line).character;
        //   await vscode.commands.executeCommand('cursorMove', {
        //     to: 'right',
        //     select: false,
        //     by: 'character',
        //     value: 1,
        //   });
        //   rightMoveToCorrectPosition = currentCursorColumn - active.character - 1;
        // } else {
        //   this._desiredColumn = value;
        //   rightMoveToCorrectPosition = value;
        // }
        // await vscode.commands.executeCommand('cursorMove', {
        //   to: 'right',
        //   select: false,
        //   by: 'character',
        //   value: rightMoveToCorrectPosition,
        // });
        // if (this.editor.selection.active.line === currentLine) {
        const active = this.editor.selection.active;
        if (this.editor.selection.active.character !== 0) {
          // Inside WrappedLine
          // await vscode.commands.executeCommand('cursorMove', {
          //   to: 'right',
          //   select: isVisualMode(this.currentMode),
          //   by: 'character',
          //   value: value,
          // });
          // const active = this.editor.selection.active;
          this._desiredColumn =
            value -
            active.character +
            TextEditor.getFirstNonWhitespaceCharOnLine(active.line).character;
          // this._desiredColumn =
          //   currentCursorColumn -
          //   active.character +
          //   TextEditor.getFirstNonWhitespaceCharOnLine(active.line).character;
          // await vscode.commands.executeCommand('cursorMove', {
          //   to: 'left',
          //   select: isVisualMode(this.currentMode),
          //   by: 'character',
          //   value: active.character - currentCursorColumn,
          // });
        } else {
          this._desiredColumn = value;
        }
        // await vscode.commands.executeCommand('cursorMove', {
        //   to: 'right',
        //   select: isVisualMode(this.currentMode),
        //   by: 'character',
        //   value: currentCursorColumn - active.character,
        // });
        // await vscode.commands.executeCommand('cursorMove', {
        //   to: 'down',
        //   select: isVisualMode(this.currentMode),
        //   by: 'wrappedLine',
        //   value: 1,
        // });
        this.editor.selections = currentSelections;
        this.ignoreNextSelectionChange = false;
      });
  }

  public historyTracker: HistoryTracker;

  public easyMotion: EasyMotion;

  public identity: EditorIdentity;

  public editor: vscode.TextEditor;

  /**
   * For timing out remapped keys like jj to esc.
   */
  public lastKeyPressedTimestamp = 0;

  /**
   * Are multiple cursors currently present?
   */
  // TODO: why isn't this a function?
  public isMultiCursor = false;

  /**
   * Is the multicursor something like visual block "multicursor", where
   * natively in vim there would only be one cursor whose changes were applied
   * to all lines after edit.
   */
  public isFakeMultiCursor = false;

  /**
   * Tracks movements that can be repeated with ; (e.g. t, T, f, and F).
   */
  public lastSemicolonRepeatableMovement: BaseMovement | undefined = undefined;

  /**
   * Tracks movements that can be repeated with , (e.g. t, T, f, and F).
   */
  public lastCommaRepeatableMovement: BaseMovement | undefined = undefined;

  public lastMovementFailed: boolean = false;

  public alteredHistory = false;

  public isRunningDotCommand = false;

  /**
   * The last visual selection before running the dot command
   */
  public dotCommandPreviousVisualSelection: vscode.Selection | undefined = undefined;

  /**
   * The first line number that was visible when SearchInProgressMode began (undefined if not searching)
   */
  public firstVisibleLineBeforeSearch: number | undefined = undefined;

  public focusChanged = false;

  public surround:
    | undefined
    | {
        active: boolean;
        operator: 'change' | 'delete' | 'yank';
        target: string | undefined;
        replacement: string | undefined;
        range: Range | undefined;
        previousMode: Mode;
      } = undefined;

  /**
   * Used for `<C-o>` in insert mode, which allows you run one normal mode
   * command, then go back to insert mode.
   */
  public returnToInsertAfterCommand = false;
  public actionCount = 0;

  /**
   * Every time we invoke a VSCode command which might trigger a view update.
   * We should postpone its view updating phase to avoid conflicting with our internal view updating mechanism.
   * This array is used to cache every VSCode view updating event and they will be triggered once we run the inhouse `viewUpdate`.
   */
  public postponedCodeViewChanges: ViewChange[] = [];

  /**
   * Used to prevent non-recursive remappings from looping.
   */
  public isCurrentlyPerformingRemapping = false;

  /**
   * All the keys we've pressed so far.
   */
  public keyHistory: string[] = [];

  /**
   * The cursor position (start, stop) when this action finishes.
   */
  public get cursorStartPosition(): Position {
    return this.cursors[0].start;
  }
  public set cursorStartPosition(value: Position) {
    if (!value.isValid(this.editor)) {
      this.logger.warn(`invalid cursor start position. ${value.toString()}.`);
    }
    this.cursors[0] = this.cursors[0].withNewStart(value);
  }

  public get cursorStopPosition(): Position {
    return this.cursors[0].stop;
  }
  public set cursorStopPosition(value: Position) {
    if (!value.isValid(this.editor)) {
      this.logger.warn(`invalid cursor stop position. ${value.toString()}.`);
    }
    this.cursors[0] = this.cursors[0].withNewStop(value);
  }

  /**
   * The position of every cursor.
   */
  private _cursors: Range[] = [new Range(new Position(0, 0), new Position(0, 0))];

  public get cursors(): Range[] {
    return this._cursors;
  }
  public set cursors(value: Range[]) {
    const map = new Map<string, Range>();
    for (const cursor of value) {
      if (!cursor.isValid(this.editor)) {
        this.logger.warn(`invalid cursor position. ${cursor.toString()}.`);
      }

      // use a map to ensure no two cursors are at the same location.
      map.set(cursor.toString(), cursor);
    }

    this._cursors = [...map.values()];
    this.isMultiCursor = this._cursors.length > 1;
  }

  /**
   * Initial state of cursors prior to any action being performed
   */
  private _cursorsInitialState: Range[];
  public get cursorsInitialState(): Range[] {
    return this._cursorsInitialState;
  }
  public set cursorsInitialState(cursors: Range[]) {
    this._cursorsInitialState = [...cursors];
  }

  public isRecordingMacro: boolean = false;
  public isReplayingMacro: boolean = false;

  public replaceState: ReplaceState | undefined = undefined;

  /**
   * Stores last visual mode as well as what was selected for `gv`
   */
  public lastVisualSelection:
    | {
        mode: Mode;
        start: Position;
        end: Position;
      }
    | undefined = undefined;

  /**
   * Is the current mouse click the first one of a new selection? This is true only when the
   * selection is empty.
   */
  public isClickStartingANewSelection: boolean = false;
  public currentSelectionFromMouse: boolean = false;

  /**
   * The mode Vim will be in once this action finishes.
   */
  private _currentMode: Mode = Mode.Normal;

  public get currentMode(): Mode {
    return this._currentMode;
  }

  private _inputMethodSwitcher: InputMethodSwitcher;
  public async setCurrentMode(mode: Mode): Promise<void> {
    await this._inputMethodSwitcher.switchInputMethod(this._currentMode, mode);
    if (this.returnToInsertAfterCommand && mode === Mode.Insert) {
      this.returnToInsertAfterCommand = false;
    }
    this._currentMode = mode;

    if (mode === Mode.SearchInProgressMode) {
      this.firstVisibleLineBeforeSearch = this.editor.visibleRanges[0].start.line;
    } else {
      this.firstVisibleLineBeforeSearch = undefined;
    }
  }

  public currentRegisterMode = RegisterMode.AscertainFromCurrentMode;

  public get effectiveRegisterMode(): RegisterMode {
    if (this.currentRegisterMode !== RegisterMode.AscertainFromCurrentMode) {
      return this.currentRegisterMode;
    }
    switch (this.currentMode) {
      case Mode.VisualLine:
        return RegisterMode.LineWise;
      case Mode.VisualBlock:
        return RegisterMode.BlockWise;
      default:
        return RegisterMode.CharacterWise;
    }
  }

  public registerName = '"';

  public currentCommandlineText = '';
  public statusBarCursorCharacterPos = 0;

  public recordedState = new RecordedState();

  public recordedMacro = new RecordedState();

  public nvim: INVim;

  public constructor(editor: vscode.TextEditor) {
    this.editor = editor;
    this.identity = EditorIdentity.fromEditor(editor);
    this.historyTracker = new HistoryTracker(this);
    this.easyMotion = new EasyMotion();
    this._inputMethodSwitcher = new InputMethodSwitcher();
  }

  async load() {
    const m = await import('../neovim/neovim');
    this.nvim = new m.NeovimWrapper();
  }

  dispose() {
    this.nvim.dispose();
  }
}

export class ViewChange {
  public command: string;
  public args: any;
}
