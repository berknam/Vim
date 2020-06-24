export enum SpecialKeys {
  ExtensionEnable = '<ExtensionEnable>',
  ExtensionDisable = '<ExtensionDisable>',
  TimeoutFinished = '<TimeoutFinished>',
}

/**
 * Tokenize a string like "abc\<Esc>d\<C-c>" into ["a", "b", "c", "\<Esc>", "d", "\<C-c>"]
 */
export function tokenizeKeySequence(sequence: string): string[] {
  let isBracketedKey = false;
  let key = '';
  const result: string[] = [];

  // no close bracket, probably trying to do a left shift, take literal
  // char sequence
  function rawTokenize(characters: string): void {
    for (const char of characters) {
      result.push(char);
    }
  }

  for (const char of sequence) {
    key += char;

    if (char === '<') {
      if (isBracketedKey) {
        rawTokenize(key.slice(0, key.length - 1));
        key = '<';
      } else {
        isBracketedKey = true;
      }
    }

    if (char === '>') {
      isBracketedKey = false;
    }

    if (isBracketedKey) {
      continue;
    }

    result.push(key);
    key = '';
  }

  if (isBracketedKey) {
    rawTokenize(key);
  }

  return result;
}
