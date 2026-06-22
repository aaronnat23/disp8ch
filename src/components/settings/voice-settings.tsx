"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Volume2, Loader2, Mic } from "lucide-react";

type VoiceConfig = {
  voice_stt_provider: string;
  voice_stt_api_key: string | null;
  voice_tts_provider: string;
  voice_tts_api_key: string | null;
  voice_tts_voice_model: string | null;
};

const STT_PROVIDERS = [
  { value: "openai-whisper", label: "OpenAI Whisper", needsKey: false, hint: "Uses your configured OpenAI API key." },
  { value: "local-whisper", label: "Local Whisper (whisper.cpp)", needsKey: false, hint: "Connects to http://localhost:8080/v1 — requires whisper.cpp running locally." },
  { value: "deepgram", label: "Deepgram", needsKey: true, hint: "Requires a Deepgram API key." },
];

const TTS_PROVIDERS = [
  { value: "openai", label: "OpenAI TTS", needsKey: false, needsModel: false, hint: "Uses your configured OpenAI API key. Voice: alloy/echo/fable/onyx/nova/shimmer." },
  { value: "elevenlabs", label: "ElevenLabs", needsKey: true, needsModel: true, modelLabel: "Voice ID", hint: "Enter your ElevenLabs API key and a voice ID from your ElevenLabs account." },
  { value: "azure-tts", label: "Azure Cognitive Services TTS", needsKey: true, needsModel: true, modelLabel: "Voice Name", hint: "Enter your Azure speech key and the voice name (e.g. en-US-JennyNeural)." },
];

export function VoiceSettings() {
  const [voice, setVoice] = useState("alloy");
  const [speed, setSpeed] = useState("1.0");
  const [testText, setTestText] = useState("Hello! I am disp8ch, your AI assistant.");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const [sttProvider, setSttProvider] = useState("openai-whisper");
  const [sttApiKey, setSttApiKey] = useState("");
  const [ttsProvider, setTtsProvider] = useState("openai");
  const [ttsApiKey, setTtsApiKey] = useState("");
  const [ttsVoiceModel, setTtsVoiceModel] = useState("");

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/config");
      const json = await res.json() as { success: boolean; data?: Record<string, unknown> };
      if (!json.success || !json.data) return;
      const d = json.data as VoiceConfig & Record<string, unknown>;
      if (d.voice_stt_provider) setSttProvider(String(d.voice_stt_provider));
      if (d.voice_stt_api_key) setSttApiKey(String(d.voice_stt_api_key));
      if (d.voice_tts_provider) setTtsProvider(String(d.voice_tts_provider));
      if (d.voice_tts_api_key) setTtsApiKey(String(d.voice_tts_api_key));
      if (d.voice_tts_voice_model) setTtsVoiceModel(String(d.voice_tts_voice_model));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void loadConfig(); }, [loadConfig]);

  const saveProviders = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voice_stt_provider: sttProvider,
          voice_stt_api_key: sttApiKey || null,
          voice_tts_provider: ttsProvider,
          voice_tts_api_key: ttsApiKey || null,
          voice_tts_voice_model: ttsVoiceModel || null,
        }),
      });
      const json = await res.json() as { success: boolean; error?: string };
      setSaveMsg(json.success ? "Saved." : (json.error ?? "Failed"));
    } catch (e) {
      setSaveMsg(String(e));
    } finally {
      setSaving(false);
    }
  };

  const testTts = async () => {
    setTesting(true);
    try {
      const res = await fetch("/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: testText, voice, speed: parseFloat(speed) }),
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        await audio.play();
      }
    } catch { /* fail silently */ }
    setTesting(false);
  };

  const activeStt = STT_PROVIDERS.find((p) => p.value === sttProvider) ?? STT_PROVIDERS[0];
  const activeTts = TTS_PROVIDERS.find((p) => p.value === ttsProvider) ?? TTS_PROVIDERS[0];

  return (
    <div className="space-y-4">
      {/* STT Provider */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mic className="h-4 w-4" />
            Speech-to-Text (STT)
          </CardTitle>
          <CardDescription>Provider used by voice-stt workflow nodes and WebChat voice input.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>STT Provider</Label>
            <Select value={sttProvider} onValueChange={setSttProvider}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {STT_PROVIDERS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{activeStt.hint}</p>
          </div>
          {activeStt.needsKey && (
            <div className="space-y-2">
              <Label>API Key</Label>
              <Input
                type="password"
                placeholder="sk-..."
                value={sttApiKey}
                onChange={(e) => setSttApiKey(e.target.value)}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* TTS Provider */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Volume2 className="h-4 w-4" />
            Text-to-Speech (TTS)
          </CardTitle>
          <CardDescription>Provider used by voice-tts workflow nodes and WebChat voice output.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>TTS Provider</Label>
            <Select value={ttsProvider} onValueChange={setTtsProvider}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TTS_PROVIDERS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{activeTts.hint}</p>
          </div>
          {activeTts.needsKey && (
            <div className="space-y-2">
              <Label>API Key</Label>
              <Input
                type="password"
                placeholder="..."
                value={ttsApiKey}
                onChange={(e) => setTtsApiKey(e.target.value)}
              />
            </div>
          )}
          {activeTts.needsModel && (
            <div className="space-y-2">
              <Label>{activeTts.modelLabel ?? "Voice Model"}</Label>
              <Input
                placeholder={ttsProvider === "elevenlabs" ? "voice-id-from-elevenlabs" : "en-US-JennyNeural"}
                value={ttsVoiceModel}
                onChange={(e) => setTtsVoiceModel(e.target.value)}
              />
            </div>
          )}
          {ttsProvider === "openai" && (
            <>
              <div className="space-y-2">
                <Label>Default Voice</Label>
                <Select value={voice} onValueChange={setVoice}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["alloy", "echo", "fable", "onyx", "nova", "shimmer"].map((v) => (
                      <SelectItem key={v} value={v}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Speed</Label>
                <Input
                  type="number" min="0.25" max="4" step="0.25"
                  value={speed} onChange={(e) => setSpeed(e.target.value)}
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Save + Test row */}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void saveProviders()} disabled={saving}>
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Save Voice Settings
        </Button>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Input
            className="flex-1"
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            placeholder="Test text…"
          />
          <Button variant="outline" onClick={testTts} disabled={testing || !testText}>
            {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Volume2 className="mr-2 h-4 w-4" />}
            Test TTS
          </Button>
        </div>
      </div>
      {saveMsg && (
        <Badge variant={saveMsg === "Saved." ? "default" : "destructive"} className="text-xs">
          {saveMsg}
        </Badge>
      )}
    </div>
  );
}
