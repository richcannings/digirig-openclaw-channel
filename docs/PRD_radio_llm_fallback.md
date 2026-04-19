# Product Requirements Document (PRD): Configurable Radio LLM & Offline Fallback

## 1. Objective
To maximize on-air response speed and ensure system survivability during internet outages by allowing the DigiRig channel to specify its own distinct LLM (independent of the global OpenClaw default) and supporting automatic fallback to a local offline model (e.g., Ollama).

## 2. Background & Motivation
- **Speed (Latency Reduction):** Operating on the radio requires fast turnaround. While the global OpenClaw agent might default to a heavy reasoning model (like Gemini 3.1 Pro or Claude Opus), the radio channel should use a significantly faster model (like Gemini 3.1 Flash) for standard QSOs.
- **Survivability (Emergency Ops):** Ham radio's core purpose is emergency communication. If the internet goes down, the AI must remain functional. By failing over to a local Ollama model (e.g., `ollama/llama3` or `ollama/phi3`), the AI can continue operating, sending/receiving local packets (via Direwolf), and managing hardware without cloud dependency.

## 3. Core Features

### 3.1 Per-Channel Model Configuration
The DigiRig plugin configuration will be expanded to accept a dedicated `model` string. When the channel dispatches a message to the OpenClaw agent routing system, it will forcefully override the session model to this specified model.

### 3.2 Automated Offline Fallback
The configuration will support an `offlineFallbackModel` string. 
- When the channel detects a network timeout or receives a fatal connection error from the primary cloud provider, it will automatically switch the active model to the fallback (e.g., an Ollama model running locally on the node).
- When internet is restored, it can revert to the primary model (or wait for a manual reset command over the air).

## 4. Configuration Schema Updates
The `DigirigConfig` will be updated to include an `llm` block:
```typescript
interface DigirigConfig {
  // ... existing config
  llm: {
    enabled: boolean;                 // Whether to override the global agent model
    primaryModel: string;             // e.g., "google/gemini-3.1-flash-lite-preview"
    fallbackModel: string;            // e.g., "ollama/llama3-8b"
    autoFallbackOnNetworkError: boolean; 
  }
}
```

## 5. Implementation Details
- **Middleware Injection:** The model override will be injected into the `createRadioContextPayload` or the `runtime.channel.routing` dispatch request.
- **Error Trapping:** The `agentWorker` in `runtime.ts` will catch network-specific errors from `dispatchRadioReply`. If `autoFallbackOnNetworkError` is true and a network error occurs, it will silently re-dispatch the job using the `fallbackModel` before triggering the `error.wav` tone.
- **Notification (Optional):** The AI can be instructed via its prompt to announce when it is operating on backup systems (e.g., "W6RGC/AI, operating on local backup power and logic...").

## 6. Success Metrics
- Ability to configure the radio channel to use Gemini Flash while the web UI uses Gemini Pro.
- Unplugging the ethernet cable results in uninterrupted (though perhaps less capable) radio operation via Ollama.