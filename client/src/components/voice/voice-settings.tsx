import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Mic, MicOff, Volume2, VolumeX, Settings } from 'lucide-react';
import { useVoiceNarration } from '@/hooks/use-voice-narration';

export default function VoiceSettings() {
  const {
    isSupported,
    isListening,
    voices,
    settings,
    updateSettings,
    speak,
    startListening,
    stopListening,
  } = useVoiceNarration();

  const [recognition, setRecognition] = useState<any>(null);

  const handleVoiceTest = () => {
    speak('This is a test of the voice narration system. Your account activity will be announced in this voice.');
  };

  const handleListeningToggle = () => {
    if (isListening) {
      stopListening();
      if (recognition) {
        recognition.stop();
      }
    } else {
      const rec = startListening();
      setRecognition(rec);
    }
  };

  if (!isSupported) {
    return (
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <VolumeX className="w-5 h-5" />
            Voice Narration Not Supported
          </CardTitle>
          <CardDescription>
            Your browser doesn't support voice features. Please use a modern browser like Chrome, Firefox, or Safari.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Volume2 className="w-5 h-5" />
          Voice Narration Settings
        </CardTitle>
        <CardDescription>
          Configure voice accessibility features for transaction narration and voice commands.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Auto Narration */}
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Label htmlFor="auto-narrate">Auto Narration</Label>
            <p className="text-sm text-muted-foreground">
              Automatically announce transactions and balance changes
            </p>
          </div>
          <Switch
            id="auto-narrate"
            checked={settings.autoNarrate}
            onCheckedChange={(checked) => updateSettings({ autoNarrate: checked })}
          />
        </div>

        {/* Voice Commands */}
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Label htmlFor="voice-commands">Voice Commands</Label>
            <p className="text-sm text-muted-foreground">
              Control your account with voice commands
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="voice-commands"
              checked={settings.voiceCommands}
              onCheckedChange={(checked) => updateSettings({ voiceCommands: checked })}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={handleListeningToggle}
              disabled={!settings.voiceCommands}
            >
              {isListening ? (
                <>
                  <MicOff className="w-4 h-4 mr-2" />
                  Stop Listening
                </>
              ) : (
                <>
                  <Mic className="w-4 h-4 mr-2" />
                  Start Listening
                </>
              )}
            </Button>
          </div>
        </div>

        {isListening && (
          <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg">
            <Badge variant="secondary" className="mb-2">
              <Mic className="w-3 h-3 mr-1" />
              Listening for voice commands
            </Badge>
            <p className="text-sm text-muted-foreground">
              Try saying: "balance", "help", "inflow", "outflow", or "transfer"
            </p>
          </div>
        )}

        {/* Voice Selection */}
        <div className="space-y-2">
          <Label htmlFor="voice-select">Voice</Label>
          <Select
            value={settings.selectedVoice}
            onValueChange={(value) => updateSettings({ selectedVoice: value })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select a voice" />
            </SelectTrigger>
            <SelectContent>
              {voices.map((voice) => (
                <SelectItem key={voice.name} value={voice.name}>
                  {voice.name} ({voice.lang})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Speech Rate */}
        <div className="space-y-2">
          <Label htmlFor="speech-rate">Speech Rate: {settings.rate}x</Label>
          <Slider
            id="speech-rate"
            min={0.5}
            max={2}
            step={0.1}
            value={[settings.rate]}
            onValueChange={(value) => updateSettings({ rate: value[0] })}
            className="w-full"
          />
        </div>

        {/* Pitch */}
        <div className="space-y-2">
          <Label htmlFor="pitch">Pitch: {settings.pitch}</Label>
          <Slider
            id="pitch"
            min={0.5}
            max={2}
            step={0.1}
            value={[settings.pitch]}
            onValueChange={(value) => updateSettings({ pitch: value[0] })}
            className="w-full"
          />
        </div>

        {/* Volume */}
        <div className="space-y-2">
          <Label htmlFor="volume">Volume: {Math.round(settings.volume * 100)}%</Label>
          <Slider
            id="volume"
            min={0}
            max={1}
            step={0.1}
            value={[settings.volume]}
            onValueChange={(value) => updateSettings({ volume: value[0] })}
            className="w-full"
          />
        </div>

        {/* Test Button */}
        <Button onClick={handleVoiceTest} className="w-full">
          <Volume2 className="w-4 h-4 mr-2" />
          Test Voice Narration
        </Button>

        {/* Voice Commands Help */}
        <div className="bg-gray-50 dark:bg-gray-900/50 p-4 rounded-lg">
          <h4 className="font-medium mb-2">Available Voice Commands:</h4>
          <ul className="text-sm space-y-1 text-muted-foreground">
            <li>• "Balance" - Hear your account balances</li>
            <li>• "Help" - Get list of available commands</li>
            <li>• "Inflow" - Record an inflow transaction</li>
            <li>• "Outflow" - Record an outflow transaction</li>
            <li>• "Transfer" - Start a transfer transaction</li>
            <li>• "Stop listening" - Disable voice commands</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}