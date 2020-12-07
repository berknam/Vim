import { configuration } from './../configuration/configuration';
import { VimState } from './../state/vimState';
import { Mode } from './../mode/mode';

const modes = {};

modes[Mode.Normal] = {
  '<left>': '<',
  '<right>': '>',
  '<space>': 's',
  '<BS>': 'b',
};

modes[Mode.Visual] = modes[Mode.Normal];
modes[Mode.VisualLine] = modes[Mode.Normal];
modes[Mode.VisualBlock] = modes[Mode.Normal];

modes[Mode.Insert] = {
  '<left>': '[',
  '<right>': ']',
};

modes[Mode.Replace] = modes[Mode.Insert];

const translateMovementKey = (mode: Mode, key: string) => {
  return (modes[mode] || {})[key] || key;
};

export const shouldWrapKey = (vimState: VimState, keysPressed: string[]): boolean => {
  const key = translateMovementKey(vimState.currentMode, keysPressed[0]);
  return !!configuration.wrapKeys[key];
};
