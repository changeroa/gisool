export class GisoolStartupError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = "GisoolStartupError";
    this.code = code;
  }
}

export const MIN_NODE: readonly [number, number] = [24, 15];

export function assertNodeVersion(version: string = process.versions.node): void {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    throw new GisoolStartupError("node_too_old", `gisool needs Node >= ${MIN_NODE.join(".")}, found ${version}`);
  }
}

export function assertPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") throw new GisoolStartupError("unsupported_platform", "gisool supports macOS and Linux");
}
