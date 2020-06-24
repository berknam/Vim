import { ErrorCode, VimError } from '../../error';
import { Scanner } from '../scanner';
import { NormalCommand, INormalCommandArguments } from '../commands/normal';

export function parseNormalCommandArgs(args: string): NormalCommand {
  if (!args) {
    return new NormalCommand({});
  }

  const scannedArgs: INormalCommandArguments = {};
  const scanner = new Scanner(args);
  const c = scanner.next();

  if (c === '!') {
    scannedArgs.bang = true;
    scanner.ignore();
  } else if (c !== ' ') {
    throw VimError.fromCode(ErrorCode.TrailingCharacters);
  }
  scanner.skipWhiteSpace();

  if (!scanner.isAtEof) {
    scannedArgs.keystrokes = scanner.remaining();
  }
  return new NormalCommand(scannedArgs);
}
