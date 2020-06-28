import { configuration } from './configuration';

export class Notation {
  // Mapping from a regex to the normalized string that it should be converted to.
  private static readonly _notationMap: Array<[RegExp, string]> = [
    [/<ctrl\+|<c\-/gi, '<C-'],
    [/<cmd\+|<d\-/gi, '<D-'],
    [/<escape>|<esc>/gi, '<Esc>'],
    [/<backspace>|<bs>/gi, '<BS>'],
    [/<delete>|<del>/gi, '<Del>'],
    [/<home>/gi, '<Home>'],
    [/<end>/gi, '<End>'],
    [/<insert>/gi, '<Insert>'],
    [/<space>/gi, ' '],
    [/<cr>|<enter>/gi, '\n'],
  ];

  /**
   * Converts keystroke like <tab> to a single control character like \t
   */
  public static ToControlCharacter(key: string) {
    if (key === '<tab>') {
      return '\t';
    }

    return key;
  }

  public static IsControlKey(key: string): boolean {
    key = key.toLocaleUpperCase();
    return (
      this.isSurroundedByAngleBrackets(key) &&
      key !== '<BS>' &&
      key !== '<SHIFT+BS>' &&
      key !== '<TAB>'
    );
  }

  /**
   * Normalizes key to AngleBracketNotation
   * (e.g. <ctrl+x>, Ctrl+x, <c-x> normalized to <C-x>)
   * and converts the characters to their literals
   * (e.g. <space>, <cr>, <leader>)
   */
  public static NormalizeKey(key: string, leaderKey: string): string {
    if (typeof key !== 'string') {
      return key;
    }

    if (key.length === 1) {
      return key;
    }

    let originalKey: string = key.slice(0);
    key = key.toLocaleLowerCase();

    if (!this.isSurroundedByAngleBrackets(key)) {
      key = `<${key}>`;
      originalKey = `<${originalKey}>`;
    }

    if (key === '<leader>') {
      return leaderKey;
    }

    if (['<up>', '<down>', '<left>', '<right>'].includes(key)) {
      return key;
    }

    for (const [regex, standardNotation] of this._notationMap) {
      key = key.replace(regex, standardNotation);
    }

    if (originalKey.toLocaleLowerCase() === key) {
      return originalKey;
    } else {
      return key;
    }
  }

  /**
   * Converts a key to a form which will look nice when logged, etc.
   */
  public static printableKey(key: string) {
    const normalized = this.NormalizeKey(key, configuration.leader);
    return normalized === ' ' ? '<space>' : normalized === '\n' ? '<enter>' : normalized;
  }

  private static isSurroundedByAngleBrackets(key: string): boolean {
    return key.startsWith('<') && key.endsWith('>');
  }
}
