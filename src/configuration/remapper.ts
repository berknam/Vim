import * as vscode from 'vscode';
import { IKeyRemapping } from './iconfiguration';
import { Logger } from '../util/logger';
import { ModeHandler } from '../mode/modeHandler';
import { Mode } from '../mode/mode';
import { VimState } from './../state/vimState';
import { commandLine } from '../cmd_line/commandLine';
import { configuration } from '../configuration/configuration';
import { StatusBar } from '../statusBar';

interface IRemapper {
  /**
   * Send keys to remapper
   */
  sendKey(keys: string[], modeHandler: ModeHandler, vimState: VimState): Promise<boolean>;

  /**
   * Given keys pressed thus far, denotes if it is a potential remap
   */
  readonly isPotentialRemap: boolean;
}

export class Remappers implements IRemapper {
  private remappers: IRemapper[];
  private operatorPendingRemappers: IRemapper[];

  constructor() {
    this.remappers = [
      new InsertModeRemapper(true),
      new NormalModeRemapper(true),
      new VisualModeRemapper(true),
      new CommandLineModeRemapper(true),
      new InsertModeRemapper(false),
      new NormalModeRemapper(false),
      new VisualModeRemapper(false),
      new CommandLineModeRemapper(false),
    ];
    this.operatorPendingRemappers = [
      new OperatorPendingModeRemapper(true),
      new OperatorPendingModeRemapper(false),
    ];
  }

  get isPotentialRemap(): boolean {
    return this.remappers.some((r) => r.isPotentialRemap);
  }

  public async sendKey(
    keys: string[],
    modeHandler: ModeHandler,
    vimState: VimState
  ): Promise<boolean> {
    let handled = false;
    const remappersToLookup = vimState.recordedState.isOperatorPending(vimState.currentMode)
      ? this.operatorPendingRemappers
      : this.remappers;

    for (let remapper of remappersToLookup) {
      handled = handled || (await remapper.sendKey(keys, modeHandler, vimState));
    }
    return handled;
  }
}

export class Remapper implements IRemapper {
  private readonly _configKey: string;
  private readonly _remappedModes: Mode[];
  private readonly _recursive: boolean;
  private readonly _logger = Logger.get('Remapper');

  /**
   * Config key of the other type of recursiveness for this mode Remapper.
   */
  private readonly _otherConfigKey: string;

  /**
   * Checks if the current commandList is a potential remap.
   */
  private _isPotentialRemap = false;

  /**
   * If the commandList has a remap but is still a potential remap we
   * call it an Ambiguous Remap.
   */
  private _hasAmbiguousRemap = false;

  /**
   * If the commandList is a potential remap but has no ambiguous remap
   * yet, we say that it has a Potential Remap.
   *
   * This is to distinguish the commands with ambiguous remaps and the
   * ones without.
   *
   * Example 1: if 'aaaa' is mapped and so is 'aa', when the user has pressed
   * 'aaa' we say it has an Ambiguous Remap which is 'aa', because if the
   * user presses other key than 'a' next or waits for the timeout to finish
   * we need to now that there was a remap to run so we first run the 'aa'
   * remap and then handle the remaining keys.
   *
   * Example 2: if only 'aaaa' is mapped, when the user has pressed 'aaa'
   * we say it has a Potential Remap, because if the user presses other key
   * than 'a' next or waits for the timeout to finish we need to now that
   * there was a potential remap that never came or was broken, so we can
   * resend the keys again without allowing for a potential remap on the first
   * key, which means we won't get to the same state because the first key
   * will be handled as an action (in this case a 'CommandInsertAfterCursor')
   */
  private _hasPotentialRemap = false;

  get isPotentialRemap(): boolean {
    return this._isPotentialRemap;
  }

  constructor(configKey: string, remappedModes: Mode[], recursive: boolean) {
    this._configKey = configKey;
    this._recursive = recursive;
    this._remappedModes = remappedModes;
    if (recursive) {
      this._otherConfigKey = `${this._configKey.slice(
        0,
        this._configKey.indexOf('Map')
      )}NonRecursiveMap`;
    } else {
      this._otherConfigKey = `${this._configKey.slice(
        0,
        this._configKey.indexOf('NonRecursive')
      )}Map`;
    }
  }

  public async sendKey(
    keys: string[],
    modeHandler: ModeHandler,
    vimState: VimState
  ): Promise<boolean> {
    this._isPotentialRemap = false;
    const allowPotentialRemapOnFirstKey = vimState.recordedState.allowPotentialRemapOnFirstKey;
    let allowBufferingKeys = true;
    let remainingKeys: string[] = [];

    if (!this._remappedModes.includes(vimState.currentMode)) {
      return false;
    }

    const userDefinedRemappings = configuration[this._configKey] as Map<string, IKeyRemapping>;

    if (keys[keys.length - 1] === '<BufferedKeys>') {
      // Timeout finished. Don't let an ambiguous or potential remap start another timeout again
      keys = keys.slice(0, keys.length - 1);
      allowBufferingKeys = false;
    }

    if (keys.length === 0) {
      return true;
    }

    this._logger.debug(
      `trying to find matching remap. keys=${keys}. mode=${
        Mode[vimState.currentMode]
      }. keybindings=${this._configKey}.`
    );

    let remapping: IKeyRemapping | undefined = this.findMatchingRemap(
      userDefinedRemappings,
      keys,
      vimState.currentMode
    );

    let isPotentialRemap = false;
    let isPotentialRemapOnOtherRemappings = false;
    // Check to see if a remapping could potentially be applied when more keys are received
    const keysAsString = keys.join('');
    if (keysAsString !== '') {
      for (let remap of userDefinedRemappings.keys()) {
        if (remap.startsWith(keysAsString) && remap !== keysAsString) {
          isPotentialRemap = true;
          break;
        }
      }
    }
    if (!isPotentialRemap) {
      // Check the other remappings for this mode
      const otherDefinedRemappings = configuration[this._otherConfigKey] as Map<
        string,
        IKeyRemapping
      >;
      if (keysAsString !== '') {
        for (let remap of otherDefinedRemappings.keys()) {
          if (remap.startsWith(keysAsString)) {
            isPotentialRemapOnOtherRemappings = true;
            break;
          }
        }
      }
    }

    this._isPotentialRemap =
      isPotentialRemap && allowBufferingKeys && allowPotentialRemapOnFirstKey;

    if (
      !remapping &&
      (this._hasAmbiguousRemap || this._hasPotentialRemap) &&
      (!(isPotentialRemap || isPotentialRemapOnOtherRemappings) || !allowBufferingKeys) &&
      keys.length > 1
    ) {
      if (this._hasAmbiguousRemap) {
        // Check what was the previous ambiguous remap
        const range = Remapper.getRemappedKeysLengthRange(userDefinedRemappings);
        for (let sliceLength = keys.length - 1; sliceLength >= range[0]; sliceLength--) {
          const keysSlice = keys.slice(0, sliceLength);
          let possibleBrokenRemap: IKeyRemapping | undefined = this.findMatchingRemap(
            userDefinedRemappings,
            keysSlice,
            vimState.currentMode
          );
          if (possibleBrokenRemap) {
            remapping = possibleBrokenRemap;
            isPotentialRemap = false;
            this._isPotentialRemap = false;
            remainingKeys = vimState.recordedState.commandList.slice(remapping.before.length); // includes the '<BufferedKeys>' key
            break;
          }
        }
        this._hasAmbiguousRemap = false;
      }
      if (!remapping) {
        // if there is still no remapping, handle all the keys without allowing
        // a potential remap on the first key so that we don't repeat everything
        // again, but still allow for other ambiguous remaps after the first key.
        //
        // Example: if 'iiii' is mapped in normal and 'ii' is mapped in insert mode,
        // and the user presses 'iiia' in normal mode or presses 'iii' and waits
        // for the timeout to finish, we want the first 'i' to be handled without
        // allowing potential remaps, which means it will go into insert mode,
        // but then the next 'ii' should be remapped in insert mode and after the
        // remap the 'a' should be handled.
        if (!allowBufferingKeys) {
          // Timeout finished and there is no remapping, so handle the buffered
          // keys but resend the '<BufferedKeys>' key as well so we don't wait
          // for the timeout again but can still handle potential remaps.
          //
          // Example 1: if 'ccc' is mapped in normal mode and user presses 'cc' and
          // waits for the timeout to finish, this will resend the 'cc<BufferedKeys>'
          // keys without allowing a potential remap on first key, which makes the
          // first 'c' be handled as a 'ChangeOperator' and the second 'c' which has
          // potential remaps (the 'ccc' remap) is buffered and the timeout started
          // but then the '<BufferedKeys>' key comes straight away that clears the
          // timeout without waiting again, and makes the second 'c' be handled normally
          // as another 'ChangeOperator'.
          //
          // Example 2: if 'iiii' is mapped in normal and 'ii' is mapped in insert
          // mode, and the user presses 'iii' in normal mode and waits for the timeout
          // to finish, this will resend the 'iii<BufferedKeys>' keys without allowing
          // a potential remap on first key, which makes the first 'i' be handled as
          // an 'CommandInsertAtCursor' and goes to insert mode, next the second 'i'
          // is buffered, then the third 'i' finds the insert mode remapping of 'ii'
          // and handles that remap, after the remapping being handled the '<BufferedKeys>'
          // key comes that clears the timeout and since the commandList will be empty
          // we return true as we finished handling this sequence of keys.

          keys.push('<BufferedKeys>'); // include the '<BufferedKeys>' key

          this._logger.debug(
            `${this._configKey}. timeout finished, handling timed out buffer keys without allowing a new timeout.`
          );
        }
        this._logger.debug(
          `${this._configKey}. potential remap broken. resending keys without allowing a potential remap on first key. keys=${keys}`
        );
        this._hasPotentialRemap = false;
        vimState.recordedState.allowPotentialRemapOnFirstKey = false;
        vimState.recordedState.resetCommandList();
        await modeHandler.handleMultipleKeyEvents(keys);
        return true;
      }
    }

    if (isPotentialRemap && allowBufferingKeys && allowPotentialRemapOnFirstKey) {
      if (remapping) {
        // There are other potential remaps (ambiguous remaps), wait for other
        // key or for the timeout to finish.
        this._hasAmbiguousRemap = true;

        this._logger.debug(
          `${this._configKey}. ambiguous match found. before=${remapping.before}. after=${remapping.after}. command=${remapping.commands}. waiting for other key or timeout to finish.`
        );
      } else {
        this._hasPotentialRemap = true;
        this._logger.debug(
          `${this._configKey}. potential remap found. waiting for other key or timeout to finish.`
        );
      }
      vimState.recordedState.bufferedKeys = [...keys];
      vimState.recordedState.bufferedKeysTimeoutObj = setTimeout(() => {
        modeHandler.handleKeyEvent('<BufferedKeys>');
      }, configuration.timeout);
      return true;
    }

    if (remapping) {
      if (!allowBufferingKeys) {
        // If the user already waited for the timeout to finish, prevent the
        // remapping from waiting for the timeout again by making a clone of
        // remapping and change 'after' to send the '<BufferedKeys>' key at
        // the end.
        let newRemapping = { ...remapping };
        newRemapping.after = remapping.after?.slice(0);
        newRemapping.after?.push('<BufferedKeys>');
        remapping = newRemapping;
      }

      this._logger.debug(
        `${this._configKey}. match found. before=${remapping.before}. after=${remapping.after}. command=${remapping.commands}. remainingKeys=${remainingKeys}`
      );

      this._hasAmbiguousRemap = false;
      this._hasPotentialRemap = false;

      let skipFirstCharacter = false;

      if (!this._recursive) {
        vimState.isCurrentlyPerformingRemapping = true;
      } else {
        // As per the Vim documentation: (:help recursive)
        // If the {rhs} starts with {lhs}, the first character is not mapped
        // again (this is Vi compatible).
        // For example:
        // map ab abcd
        // will execute the "a" command and insert "bcd" in the text. The "ab"
        // in the {rhs} will not be mapped again.
        if (remapping.after?.join('').startsWith(remapping.before.join(''))) {
          skipFirstCharacter = true;
        }
      }

      try {
        await this.handleRemapping(remapping, vimState, modeHandler, skipFirstCharacter);
      } finally {
        vimState.isCurrentlyPerformingRemapping = false;
        if (remainingKeys.length > 0) {
          await modeHandler.handleMultipleKeyEvents(remainingKeys);
          return true;
        }
      }

      return true;
    }

    this._hasPotentialRemap = false;
    return false;
  }

  private async handleRemapping(
    remapping: IKeyRemapping,
    vimState: VimState,
    modeHandler: ModeHandler,
    skipFirstCharacter: boolean
  ) {
    vimState.recordedState.resetCommandList();
    if (remapping.after) {
      const count = vimState.recordedState.count || 1;
      vimState.recordedState.count = 0;
      for (let i = 0; i < count; i++) {
        if (skipFirstCharacter) {
          vimState.isCurrentlyPerformingRemapping = true;
          await modeHandler.handleKeyEvent(remapping.after[0]);
          vimState.isCurrentlyPerformingRemapping = false;
          await modeHandler.handleMultipleKeyEvents(remapping.after.slice(1));
        } else {
          await modeHandler.handleMultipleKeyEvents(remapping.after);
        }
      }
    }

    if (remapping.commands) {
      for (const command of remapping.commands) {
        let commandString: string;
        let commandArgs: string[];
        if (typeof command === 'string') {
          commandString = command;
          commandArgs = [];
        } else {
          commandString = command.command;
          commandArgs = command.args;
        }

        if (commandString.slice(0, 1) === ':') {
          // Check if this is a vim command by looking for :
          await commandLine.Run(commandString.slice(1, commandString.length), modeHandler.vimState);
          await modeHandler.updateView(modeHandler.vimState);
        } else if (commandArgs) {
          await vscode.commands.executeCommand(commandString, commandArgs);
        } else {
          await vscode.commands.executeCommand(commandString);
        }

        StatusBar.setText(vimState, `${commandString} ${commandArgs}`);
      }
    }
  }

  protected findMatchingRemap(
    userDefinedRemappings: Map<string, IKeyRemapping>,
    inputtedKeys: string[],
    currentMode: Mode
  ): IKeyRemapping | undefined {
    if (userDefinedRemappings.size === 0) {
      return undefined;
    }

    const range = Remapper.getRemappedKeysLengthRange(userDefinedRemappings);
    const startingSliceLength = Math.max(range[1], inputtedKeys.length);
    for (let sliceLength = startingSliceLength; sliceLength >= range[0]; sliceLength--) {
      const keySlice = inputtedKeys.slice(-sliceLength).join('');

      this._logger.verbose(`key=${inputtedKeys}. keySlice=${keySlice}.`);
      if (userDefinedRemappings.has(keySlice)) {
        // In Insert mode, we allow users to precede remapped commands
        // with extraneous keystrokes (eg. "hello world jj")
        // In other modes, we have to precisely match the keysequence
        // unless the preceding keys are numbers
        if (currentMode !== Mode.Insert) {
          const precedingKeys = inputtedKeys
            .slice(0, inputtedKeys.length - keySlice.length)
            .join('');
          if (precedingKeys.length > 0 && !/^[0-9]+$/.test(precedingKeys)) {
            this._logger.verbose(
              `key sequences need to match precisely. precedingKeys=${precedingKeys}.`
            );
            break;
          }
        }

        return userDefinedRemappings.get(keySlice);
      }
    }

    return undefined;
  }

  /**
   * Given list of remappings, returns the length of the shortest and longest remapped keys
   * @param remappings
   */
  protected static getRemappedKeysLengthRange(
    remappings: Map<string, IKeyRemapping>
  ): [number, number] {
    if (remappings.size === 0) {
      return [0, 0];
    }
    const keyLengths = Array.from(remappings.keys()).map((k) => k.length);
    return [Math.min(...keyLengths), Math.max(...keyLengths)];
  }
}

function keyBindingsConfigKey(mode: string, recursive: boolean): string {
  return `${mode}ModeKeyBindings${recursive ? '' : 'NonRecursive'}Map`;
}

class InsertModeRemapper extends Remapper {
  constructor(recursive: boolean) {
    super(keyBindingsConfigKey('insert', recursive), [Mode.Insert, Mode.Replace], recursive);
  }
}

class NormalModeRemapper extends Remapper {
  constructor(recursive: boolean) {
    super(keyBindingsConfigKey('normal', recursive), [Mode.Normal], recursive);
  }
}

class OperatorPendingModeRemapper extends Remapper {
  constructor(recursive: boolean) {
    super(keyBindingsConfigKey('operatorPending', recursive), [Mode.Normal], recursive);
  }
}

class VisualModeRemapper extends Remapper {
  constructor(recursive: boolean) {
    super(
      keyBindingsConfigKey('visual', recursive),
      [Mode.Visual, Mode.VisualLine, Mode.VisualBlock],
      recursive
    );
  }
}

class CommandLineModeRemapper extends Remapper {
  constructor(recursive: boolean) {
    super(
      keyBindingsConfigKey('commandLine', recursive),
      [Mode.CommandlineInProgress, Mode.SearchInProgressMode],
      recursive
    );
  }
}
