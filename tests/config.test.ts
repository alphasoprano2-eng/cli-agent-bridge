
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  getConfigPath,
  loadConfig,
  maskSecret,
  resetConfig,
  writeConfig,
} from "../src/config.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "agent-bridge-config-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("configuration", () => {
  it("applies CLI, process environment, .env, user file, then defaults", async () => {
    const root = await createTemporaryDirectory();
    const cwd = path.join(root, "project");
    const home = path.join(root, "home");

    await mkdir(cwd, { recursive: true });
    await mkdir(path.dirname(getConfigPath(home)), { recursive: true });

    await writeFile(
      getConfigPath(home),
      JSON.stringify({ ollamaModel: "from-file", timeoutSeconds: 12 }),
    );

    await writeFile(
      path.join(cwd, ".env"),
      "AGENT_BRIDGE_OLLAMA_MODEL=from-dotenv\nAGENT_BRIDGE_TIMEOUT=15\n",
    );

    const config = await loadConfig({
      cwd,
      home,
      env: { AGENT_BRIDGE_OLLAMA_MODEL: "from-env" },
      overrides: { ollamaModel: "from-cli" },
    });

    expect(config.ollamaModel).toBe("from-cli");
    expect(config.timeoutSeconds).toBe(15);
    expect(config.primary).toBe("ollama");
    expect(config.openaiModel).toBe("gpt-4o-mini");
  });

  it("writes config with private permissions and masks credentials", async () => {
    const home = await createTemporaryDirectory();
    const filePath = await writeConfig(
      { openaiApiKey: "sk-test-abcdefgh", primary: "openai" },
      home,
    );
    const fileStat = await stat(filePath);
    const persisted: unknown = JSON.parse(await readFile(filePath, "utf8"));

    if (process.platform !== "win32") {
      expect(fileStat.mode & 0o777).toBe(0o600);
    }

    expect(persisted).toMatchObject({
      openaiApiKey: "sk-test-abcdefgh",
      primary: "openai",
    });
    expect(maskSecret("sk-test-abcdefgh")).toBe("************efgh");
    expect(maskSecret("abcd")).toBe("****");
  });

  it("persists and reloads provider settings and API key", async () => {
    const home = await createTemporaryDirectory();

    await writeConfig(
      {
        primary: "openai",
        fallback: false,
        openaiApiKey: "sk-test-reload-key",
      },
      home,
    );

    const config = await loadConfig({
      home,
      env: {},
    });

    expect(config.primary).toBe("openai");
    expect(config.fallback).toBe(false);
    expect(config.openaiApiKey).toBe("sk-test-reload-key");
  });

  it("throws a helpful error when the config file contains malformed JSON", async () => {
    const home = await createTemporaryDirectory();
    const configPath = getConfigPath(home);

    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, "{ invalid json");

    await expect(loadConfig({ home, env: {} })).rejects.toThrow(
      `Could not read config at ${configPath}`,
    );
  });

  it("throws a helpful error when the config path is a directory", async () => {
    const home = await createTemporaryDirectory();
    const configPath = getConfigPath(home);

    await mkdir(path.dirname(configPath), { recursive: true });
    await mkdir(configPath);

    await expect(loadConfig({ home, env: {} })).rejects.toThrow(
      `Could not read config at ${configPath}`,
    );
  });

  it("resets persisted config", async () => {
    const home = await createTemporaryDirectory();

    await writeConfig({ ollamaModel: "custom" }, home);
    await resetConfig(home);

    await expect(loadConfig({ home })).resolves.toMatchObject({
      ollamaModel: "llama3.2",
    });
  });
});
