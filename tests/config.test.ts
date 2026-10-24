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
import { afterEach, describe, expect, it } from "vitest";
import {
  getConfigPath,
  loadConfig,
  maskSecret,
  resetConfig,
  setConfigValue,
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

    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(persisted).toMatchObject({
      openaiApiKey: "sk-test-abcdefgh",
      primary: "openai",
    });
    expect(maskSecret("sk-test-abcdefgh")).toBe("************efgh");
    expect(maskSecret("abcd")).toBe("****");
  });

  it("resets persisted config", async () => {
    const home = await createTemporaryDirectory();
    await writeConfig({ ollamaModel: "custom" }, home);
    await resetConfig(home);
    await expect(loadConfig({ home })).resolves.toMatchObject({
      ollamaModel: "llama3.2",
    });
  });

  it("uses defaults when the persistent config file does not exist", async () => {
    const root = await createTemporaryDirectory();
    const config = await loadConfig({
      home: path.join(root, "home"),
      cwd: path.join(root, "project"),
      env: {},
    });

    expect(config).toMatchObject({
      primary: "ollama",
      fallback: true,
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "llama3.2",
      openaiBaseUrl: "https://api.openai.com/v1",
      openaiModel: "gpt-4o-mini",
      timeoutSeconds: 120,
      rateLimitRetries: 2,
      logPath: ".agent-bridge.log",
      maxLogBytes: 5_000_000,
    });
  });

  it("loads and persists custom primary and fallback provider settings", async () => {
    const home = await createTemporaryDirectory();
    await writeConfig(
      {
        primary: "openai",
        fallback: false,
        openaiBaseUrl: "https://gateway.example/v1",
        openaiModel: "custom-model",
      },
      home,
    );

    await expect(loadConfig({ home, env: {} })).resolves.toMatchObject({
      primary: "openai",
      fallback: false,
      openaiBaseUrl: "https://gateway.example/v1",
      openaiModel: "custom-model",
      ollamaModel: "llama3.2",
    });
  });

  it("preserves existing settings when another setting is written", async () => {
    const home = await createTemporaryDirectory();
    await writeConfig({ primary: "openai", openaiModel: "custom-model" }, home);
    await writeConfig({ fallback: false }, home);

    const persisted = JSON.parse(
      await readFile(getConfigPath(home), "utf8"),
    ) as Record<string, unknown>;

    expect(persisted).toMatchObject({
      primary: "openai",
      openaiModel: "custom-model",
      fallback: false,
    });
  });

  it("parses environment booleans, numeric values, and the API key alias", async () => {
    const root = await createTemporaryDirectory();
    const config = await loadConfig({
      home: path.join(root, "home"),
      cwd: path.join(root, "project"),
      env: {
        AGENT_BRIDGE_FALLBACK: "off",
        AGENT_BRIDGE_TIMEOUT: "45",
        AGENT_BRIDGE_RATE_LIMIT_RETRIES: "4",
        AGENT_BRIDGE_MAX_LOG_BYTES: "2048",
        AGENT_BRIDGE_OPENAI_API_KEY: "environment-key",
      },
    });

    expect(config.fallback).toBe(false);
    expect(config.timeoutSeconds).toBe(45);
    expect(config.rateLimitRetries).toBe(4);
    expect(config.maxLogBytes).toBe(2048);
    expect(config.openaiApiKey).toBe("environment-key");
  });

  it("validates and persists setting values supplied as strings", async () => {
    const home = await createTemporaryDirectory();
    await setConfigValue("fallback", "off", home);
    await setConfigValue("timeoutSeconds", "90", home);

    await expect(loadConfig({ home, env: {} })).resolves.toMatchObject({
      fallback: false,
      timeoutSeconds: 90,
    });
    await expect(setConfigValue("fallback", "sometimes", home)).rejects.toThrow(
      "fallback must be true or false",
    );
    await expect(
      setConfigValue("unknownSetting", "value", home),
    ).rejects.toThrow("Unknown setting: unknownSetting");
  });

  it("reports malformed JSON with the configuration file path", async () => {
    const home = await createTemporaryDirectory();
    const configPath = getConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, "{not valid json");

    await expect(loadConfig({ home, env: {} })).rejects.toThrow(
      `Could not read config at ${configPath}`,
    );
  });

  it("reports a configuration path that resolves to a directory", async () => {
    const home = await createTemporaryDirectory();
    const configPath = getConfigPath(home);
    await mkdir(configPath, { recursive: true });

    await expect(loadConfig({ home, env: {} })).rejects.toThrow(
      `Could not read config at ${configPath}`,
    );
  });
});
