import * as vscode from 'vscode';
import { RegisterAction, BaseCommand } from '../base';
import { Mode, isVisualMode, isStatusBarMode } from '../../mode/mode';
import { SpecialKeys } from '../../util/specialKeys';
import { Position, laterOf } from '../../common/motion/position';
import { VimState } from '../../state/vimState';
import { DocumentContentChangeAction } from './actions';
import { Range } from '../../common/motion/range';
import { configuration } from '../../configuration/configuration';
import { Logger } from '../../util/logger';

@RegisterAction
class SyncCursorsCommand extends BaseCommand {
  modes = [
    Mode.Normal,
    Mode.Insert,
    Mode.Replace,
    Mode.Visual,
    Mode.VisualLine,
    Mode.VisualBlock,
    Mode.CommandlineInProgress,
    Mode.SearchInProgressMode,
  ];
  keys = [SpecialKeys.SyncCursors];
  runsOnceForEveryCursor() {
    return false;
  }
  runsOnceForEachCountPrefix = false;
  canBeRepeatedWithDot = false;
  private readonly _logger = Logger.get('SyncCursorsCommand');

  public async execCount(position: Position, vimState: VimState): Promise<void> {
    const selections = vimState.editor.selections;
    const selection = vimState.editor.selection;
    if (
      (selections.length !== vimState.cursors.length || vimState.isMultiCursor) &&
      vimState.currentMode !== Mode.VisualBlock
    ) {
      let allowedModes = [Mode.Normal];
      if (
        vimState.isMultiCursor &&
        !vimState.recordedState.actionsRun.some((a) => a instanceof DocumentContentChangeAction)
      ) {
        allowedModes.push(...[Mode.Insert, Mode.Replace]);
      }
      // Number of selections changed, make sure we know about all of them still
      vimState.cursors = selections.map(
        (sel) =>
          new Range(
            // Adjust the cursor positions because cursors & selections don't match exactly
            sel.anchor.isAfter(sel.active)
              ? Position.FromVSCodePosition(sel.anchor).getLeft()
              : Position.FromVSCodePosition(sel.anchor),
            sel.active.isBefore(sel.anchor)
              ? Position.FromVSCodePosition(sel.active)
              : Position.FromVSCodePosition(sel.active).getLeftThroughLineBreaks()
          )
      );
      if (
        selections.some((s) => !s.anchor.isEqual(s.active)) &&
        allowedModes.includes(vimState.currentMode)
      ) {
        // If we got a visual selection and we are on normal, insert or replace mode, enter visual mode.
        // We shouldn't go to visual mode on any other mode, because the other visual modes are handled
        // very differently than vscode so only our extension will create them. And the other modes
        // like the plugin modes shouldn't be changed or else it might mess up the plugins actions.
        await vimState.setCurrentMode(Mode.Visual);
      }
      // return this.updateView();
      return;
    }

    /**
     * We only trigger our view updating process if it's a mouse selection.
     * Otherwise we only update our internal cursor positions accordingly.
     */
    if (vimState.selectionChangedEventKind !== vscode.TextEditorSelectionChangeKind.Mouse) {
      if (selection) {
        if (vimState.selectionChangedEventKind === vscode.TextEditorSelectionChangeKind.Command) {
          // This 'Command' kind is triggered when using a command like 'editor.action.smartSelect.grow'
          // but it is also triggered when we set the 'editor.selections' on 'updateView'.
          if (
            [Mode.Normal, Mode.Visual, Mode.Insert, Mode.Replace].includes(vimState.currentMode)
          ) {
            // Since the selections weren't ignored then probably we got change of selection from
            // a command, so we need to update our start and stop positions. This is where commands
            // like 'editor.action.smartSelect.grow' are handled.
            if (vimState.currentMode === Mode.Visual) {
              this._logger.debug('Selections: Updating Visual Selection!');
              vimState.cursorStopPosition = selection.active.isBeforeOrEqual(selection.anchor)
                ? Position.FromVSCodePosition(selection.active)
                : Position.FromVSCodePosition(selection.active).getLeftThroughLineBreaks();
              vimState.cursorStartPosition = Position.FromVSCodePosition(selection.anchor);
              // await this.updateView({ drawSelection: false, revealRange: false });
              return;
            } else if (!selection.active.isEqual(selection.anchor)) {
              this._logger.debug('Selections: Creating Visual Selection from command!');
              vimState.cursorStopPosition = Position.FromVSCodePosition(
                selection.active
              ).getLeftThroughLineBreaks();
              vimState.cursorStartPosition = Position.FromVSCodePosition(selection.anchor);
              await vimState.setCurrentMode(Mode.Visual);
              // await this.updateView({ drawSelection: false, revealRange: false });
              return;
            }
          }
        }
        // Here we are on the selection changed of kind 'Keyboard' or 'undefined' which is triggered
        // when pressing movement keys that are not caught on the 'type' override but also when using
        // commands like 'cursorMove'.

        if (isVisualMode(vimState.currentMode)) {
          /**
           * In Visual Mode, our `cursorPosition` and `cursorStartPosition` can not reflect `active`,
           * `start`, `end` and `anchor` information in a selection.
           * See `Fake block cursor with text decoration` section of `updateView` method.
           * Besides this, sometimes on visual modes our start position is not the same has vscode
           * anchor because we need to move vscode anchor one to the right of our start when our start
           * is after our stop in order to include the start character on vscodes selection.
           */
          return;
        }

        const cursorEnd = laterOf(vimState.cursorStartPosition, vimState.cursorStopPosition);
        if (vimState.editor.document.validatePosition(cursorEnd).isBefore(cursorEnd)) {
          // The document changed such that our cursor position is now out of bounds, possibly by
          // another program. Let's just use VSCode's selection.
          // TODO: if this is the case, but we're in visual mode, we never get here (because of branch above)
        } else if (
          vimState.cursorStopPosition.isEqual(vimState.cursorStartPosition) &&
          vimState.cursorStopPosition.getRight().isLineEnd() &&
          vimState.cursorStopPosition.getLineEnd().isEqual(selection.active)
        ) {
          // We get here when we use a 'cursorMove' command (that is considered a selection changed
          // kind of 'Keyboard') that ends past the line break. But our cursors are already on last
          // character which is what we want. Even though our cursors will be corrected again when
          // checking if they are in bounds on 'runAction' there is no need to be changing them back
          // and forth so we check for this situation here.
          return;
        }

        // Here we allow other 'cursorMove' commands to update our cursors in case there is another
        // extension making cursor changes that we need to catch.
        //
        // We still need to be careful with this because this here might be changing our cursors
        // in ways we don't want to. So with future selection issues this is a good place to start
        // looking.
        this._logger.debug(
          `Selections: Changing Cursors from selection handler... ${Position.FromVSCodePosition(
            selection.anchor
          ).toString()}, ${Position.FromVSCodePosition(selection.active)}`
        );
        vimState.cursorStopPosition = Position.FromVSCodePosition(selection.active);
        vimState.cursorStartPosition = Position.FromVSCodePosition(selection.anchor);
        // await this.updateView({ drawSelection: false, revealRange: false });
      }
      return;
    }

    if (selections.length === 1) {
      vimState.isMultiCursor = false;
    }

    if (isStatusBarMode(vimState.currentMode)) {
      return;
    }

    let toDraw = false;

    if (selection) {
      let newPosition = Position.FromVSCodePosition(selection.active);

      // Only check on a click, not a full selection (to prevent clicking past EOL)
      if (newPosition.character >= newPosition.getLineEnd().character && selection.isEmpty) {
        if (vimState.currentMode !== Mode.Insert) {
          vimState.lastClickWasPastEol = true;

          // This prevents you from mouse clicking past the EOL
          newPosition = newPosition.withColumn(Math.max(newPosition.getLineEnd().character - 1, 0));

          // Switch back to normal mode since it was a click not a selection
          await vimState.setCurrentMode(Mode.Normal);

          toDraw = true;
        }
      } else if (selection.isEmpty) {
        vimState.lastClickWasPastEol = false;
      }

      vimState.cursorStopPosition = newPosition;
      vimState.cursorStartPosition = newPosition;
      vimState.desiredColumn = newPosition.character;

      // start visual mode?
      if (
        selection.anchor.line === selection.active.line &&
        selection.anchor.character >= newPosition.getLineEnd().character - 1 &&
        selection.active.character >= newPosition.getLineEnd().character - 1
      ) {
        // This prevents you from selecting EOL
      } else if (!selection.anchor.isEqual(selection.active)) {
        let selectionStart = new Position(selection.anchor.line, selection.anchor.character);

        if (selectionStart.character > selectionStart.getLineEnd().character) {
          selectionStart = new Position(selectionStart.line, selectionStart.getLineEnd().character);
        }

        vimState.cursorStartPosition = selectionStart;

        if (selectionStart.isAfter(newPosition)) {
          vimState.cursorStartPosition = vimState.cursorStartPosition.getLeft();
        }

        // If we prevented from clicking past eol but it is part of this selection, include the last char
        if (vimState.lastClickWasPastEol) {
          const newStart = new Position(selection.anchor.line, selection.anchor.character + 1);
          vimState.editor.selection = new vscode.Selection(newStart, selection.end);
          vimState.cursorStartPosition = selectionStart;
          vimState.lastClickWasPastEol = false;
        }

        if (
          configuration.mouseSelectionGoesIntoVisualMode &&
          !isVisualMode(vimState.currentMode) &&
          vimState.currentMode !== Mode.Insert
        ) {
          await vimState.setCurrentMode(Mode.Visual);

          // double click mouse selection causes an extra character to be selected so take one less character
        }
      } else if (vimState.currentMode !== Mode.Insert) {
        await vimState.setCurrentMode(Mode.Normal);
      }

      // this.updateView({ drawSelection: toDraw, revealRange: false });
    }
  }
}
