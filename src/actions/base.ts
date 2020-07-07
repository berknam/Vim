import { configuration } from './../configuration/configuration';
import { Mode, isVisualMode } from './../mode/mode';
import { VimState } from './../state/vimState';
import { Notation } from '../configuration/notation';
import { Globals } from '../globals';

export class BaseAction {
  /**
   * Can this action be paired with an operator (is it like w in dw)? All
   * BaseMovements can be, and some more sophisticated commands also can be.
   */
  public isMotion = false;

  /**
   * If isJump is true, then the cursor position will be added to the jump list on completion.
   */
  public isJump = false;

  public canBeRepeatedWithDot = false;

  /**
   * Whether we should change `vimState.desiredColumn`
   */
  public preservesDesiredColumn(): boolean {
    return false;
  }

  /**
   * Modes that this action can be run in.
   */
  public modes: Mode[];

  /**
   * The sequence of keys you use to trigger the action, or a list of such sequences.
   */
  public keys: string[] | string[][];

  public mustBeFirstKey = false;

  public isOperator = false;

  /**
   * The keys pressed at the time that this action was triggered.
   */
  public keysPressed: string[] = [];

  private static readonly isSingleNumber: RegExp = /^[0-9]$/;
  private static readonly isSingleAlpha: RegExp = /^[a-zA-Z]$/;

  /**
   * Is this action valid in the current Vim state?
   */
  public doesActionApply(vimState: VimState, keysPressed: string[]): boolean {
    if (
      this.mustBeFirstKey &&
      (vimState.recordedState.commandWithoutCountPrefix.length > keysPressed.length ||
        vimState.recordedState.operator)
    ) {
      return false;
    }

    return (
      this.modes.includes(vimState.currentModeIncludingPseudoModes) &&
      BaseAction.CompareKeypressSequence(this.keys, keysPressed)
    );
  }

  /**
   * Could the user be in the process of doing this action.
   */
  public couldActionApply(vimState: VimState, keysPressed: string[]): boolean {
    if (!this.modes.includes(vimState.currentModeIncludingPseudoModes)) {
      return false;
    }

    const keys2D = BaseAction.is2DArray(this.keys) ? this.keys : [this.keys];
    const keysSlice = keys2D.map((x) => x.slice(0, keysPressed.length));
    if (!BaseAction.CompareKeypressSequence(keysSlice, keysPressed)) {
      return false;
    }

    if (
      this.mustBeFirstKey &&
      (vimState.recordedState.commandWithoutCountPrefix.length > keysPressed.length ||
        vimState.recordedState.operator)
    ) {
      return false;
    }

    return true;
  }

  public static CompareKeypressSequence(one: string[] | string[][], two: string[]): boolean {
    if (BaseAction.is2DArray(one)) {
      for (const sequence of one) {
        if (BaseAction.CompareKeypressSequence(sequence, two)) {
          return true;
        }
      }

      return false;
    }

    if (one.length !== two.length) {
      return false;
    }

    for (let i = 0, j = 0; i < one.length; i++, j++) {
      const left = one[i],
        right = two[j];

      if (left === '<any>' || right === '<any>') {
        continue;
      }

      if (left === '<number>' && this.isSingleNumber.test(right)) {
        continue;
      }
      if (right === '<number>' && this.isSingleNumber.test(left)) {
        continue;
      }

      if (left === '<alpha>' && this.isSingleAlpha.test(right)) {
        continue;
      }
      if (right === '<alpha>' && this.isSingleAlpha.test(left)) {
        continue;
      }

      if (left === '<character>' && !Notation.IsControlKey(right)) {
        continue;
      }
      if (right === '<character>' && !Notation.IsControlKey(left)) {
        continue;
      }

      if (left !== right) {
        return false;
      }
    }

    return true;
  }

  public toString(): string {
    return this.keys.join('');
  }

  private static is2DArray<T>(x: any): x is T[][] {
    return Array.isArray(x[0]);
  }
}

export class BasePluginAction extends BaseAction {
  public pluginActionDefaultKeys: string[] | string[][];
}

export enum KeypressState {
  WaitingOnKeys,
  NoPossibleMatch,
}

// TODO: this should not be a class (#4429)
export abstract class Actions {
  /**
   * Every Vim action will be added here with the @RegisterAction decorator.
   */
  public static actionMap = new Map<Mode, typeof BaseAction[]>();

  /**
   * Gets the action that should be triggered given a key sequence.
   *
   * If there is a definitive action that matched, returns that action.
   *
   * If an action could potentially match if more keys were to be pressed, returns `KeyPressState.WaitingOnKeys`
   * (e.g. you pressed "g" and are about to press "g" action to make the full action "gg")
   *
   * If no action could ever match, returns `KeypressState.NoPossibleMatch`.
   */
  public static getRelevantAction(
    keysPressed: string[],
    vimState: VimState
  ): BaseAction | KeypressState {
    let isPotentialMatch = false;

    const possibleActionsForMode =
      Actions.actionMap.get(vimState.currentModeIncludingPseudoModes) || [];
    for (const actionType of possibleActionsForMode) {
      const action = new actionType();
      if (action.doesActionApply(vimState, keysPressed)) {
        action.keysPressed = vimState.recordedState.actionKeys.slice(0);
        return action;
      }

      if (action.couldActionApply(vimState, keysPressed)) {
        isPotentialMatch = true;
      }
    }

    return isPotentialMatch ? KeypressState.WaitingOnKeys : KeypressState.NoPossibleMatch;
  }
}

export function RegisterAction(action: typeof BaseAction): void {
  const actionInstance = new action();
  for (const mode of actionInstance.modes) {
    let actions = Actions.actionMap.get(mode);
    if (!actions) {
      actions = [];
      Actions.actionMap.set(mode, actions);
    }

    if (actionInstance.keys === undefined) {
      // action that can't be called directly
      continue;
    }

    actions.push(action);
  }
}

export function RegisterPluginAction(pluginName: string) {
  return (action: typeof BasePluginAction) => {
    const actionInstance = new action();
    for (const mode of actionInstance.modes) {
      let actions = Actions.actionMap.get(mode);
      if (!actions) {
        actions = [];
        Actions.actionMap.set(mode, actions);
      }

      const is2DArray = function (a: any): a is string[][] {
        return Array.isArray(a[0]);
      };

      if (
        actionInstance.keys === undefined ||
        is2DArray(actionInstance.keys) ||
        !actionInstance.keys[0].toLocaleLowerCase().startsWith('<plug>')
      ) {
        // action that can't be called directly or invalid plugin action key
        continue;
      }

      if (actionInstance.pluginActionDefaultKeys.length === 0) {
        // plugin action without default mappings. Can be mapped later by the user.
        actions.push(action);
        continue;
      }

      let remappings: any[] = [];
      if (is2DArray(actionInstance.pluginActionDefaultKeys)) {
        for (const keyset of actionInstance.pluginActionDefaultKeys) {
          remappings.push({
            before: keyset,
            after: [actionInstance.keys[0]],
            plugin: pluginName,
          });
        }
      } else {
        remappings.push({
          before: actionInstance.pluginActionDefaultKeys,
          after: [actionInstance.keys[0]],
          plugin: pluginName,
        });
      }

      // Create default mappings for the default modes. If the plugin creates another custom
      // mode we don't need to create mappings for that because only that plugin's actions
      // will apply for that mode.
      // Also store the default mappings on 'Globals.mockConfigurationDefaultBindings' to be used
      // when testing.
      if (mode === Mode.Normal) {
        configuration.defaultnormalModeKeyBindingsNonRecursive.push(...remappings);
        Globals.mockConfigurationDefaultBindings.defaultNormalModeKeyBindingsNonRecursive.push(
          ...remappings
        );
      } else if (mode === Mode.Insert || mode === Mode.Replace) {
        configuration.defaultinsertModeKeyBindingsNonRecursive.push(...remappings);
        Globals.mockConfigurationDefaultBindings.defaultInsertModeKeyBindingsNonRecursive.push(
          ...remappings
        );
      } else if (isVisualMode(mode)) {
        configuration.defaultvisualModeKeyBindingsNonRecursive.push(...remappings);
        Globals.mockConfigurationDefaultBindings.defaultVisualModeKeyBindingsNonRecursive.push(
          ...remappings
        );
      } else if (mode === Mode.CommandlineInProgress || mode === Mode.SearchInProgressMode) {
        configuration.defaultcommandLineModeKeyBindingsNonRecursive.push(...remappings);
        Globals.mockConfigurationDefaultBindings.defaultCommandLineModeKeyBindingsNonRecursive.push(
          ...remappings
        );
      } else if (mode === Mode.OperatorPendingMode) {
        configuration.defaultoperatorPendingModeKeyBindingsNonRecursive.push(...remappings);
        Globals.mockConfigurationDefaultBindings.defaultOperatorPendingModeKeyBindingsNonRecursive.push(
          ...remappings
        );
      }

      actions.push(action);
    }
  };
}
