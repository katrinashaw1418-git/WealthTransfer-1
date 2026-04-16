import { useState, useEffect, useCallback } from 'react';

interface VoiceNarrationOptions {
  enabled: boolean;
  rate: number;
  pitch: number;
  volume: number;
  voice?: SpeechSynthesisVoice;
}

interface VoiceSettings {
  autoNarrate: boolean;
  voiceCommands: boolean;
  rate: number;
  pitch: number;
  volume: number;
  selectedVoice: string;
}

export function useVoiceNarration() {
  const [isSupported, setIsSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [settings, setSettings] = useState<VoiceSettings>({
    autoNarrate: false,
    voiceCommands: false,
    rate: 1.0,
    pitch: 1.0,
    volume: 0.8,
    selectedVoice: '',
  });

  // Initialize speech synthesis
  useEffect(() => {
    if ('speechSynthesis' in window && 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
      setIsSupported(true);
      
      // Load voices
      const loadVoices = () => {
        const availableVoices = speechSynthesis.getVoices();
        setVoices(availableVoices);
        
        // Set default voice (prefer English voices)
        const englishVoice = availableVoices.find(voice => 
          voice.lang.startsWith('en') && voice.name.toLowerCase().includes('female')
        ) || availableVoices.find(voice => voice.lang.startsWith('en')) || availableVoices[0];
        
        if (englishVoice && !settings.selectedVoice) {
          setSettings(prev => ({ ...prev, selectedVoice: englishVoice.name }));
        }
      };

      loadVoices();
      speechSynthesis.onvoiceschanged = loadVoices;
    }
  }, []);

  // Load settings from localStorage
  useEffect(() => {
    const savedSettings = localStorage.getItem('voiceNarrationSettings');
    if (savedSettings) {
      setSettings(JSON.parse(savedSettings));
    }
  }, []);

  // Save settings to localStorage
  const updateSettings = useCallback((newSettings: Partial<VoiceSettings>) => {
    setSettings(prev => {
      const updated = { ...prev, ...newSettings };
      localStorage.setItem('voiceNarrationSettings', JSON.stringify(updated));
      return updated;
    });
  }, []);

  // Speak text
  const speak = useCallback((text: string, priority: 'high' | 'medium' | 'low' = 'medium') => {
    if (!isSupported || !settings.autoNarrate) return;

    // Cancel lower priority speech
    if (priority === 'high') {
      speechSynthesis.cancel();
    }

    const utterance = new SpeechSynthesisUtterance(text);
    
    // Apply voice settings
    utterance.rate = settings.rate;
    utterance.pitch = settings.pitch;
    utterance.volume = settings.volume;
    
    // Set selected voice
    if (settings.selectedVoice) {
      const selectedVoice = voices.find(voice => voice.name === settings.selectedVoice);
      if (selectedVoice) {
        utterance.voice = selectedVoice;
      }
    }

    speechSynthesis.speak(utterance);
  }, [isSupported, settings, voices]);

  // Transaction narration helpers
  const narrateTransaction = useCallback((type: string, amount: string, currency: string, details?: any) => {
    let message = '';
    
    switch (type) {
      case 'deposit':
        message = `Processing inflow of ${amount} ${currency} to your account`;
        break;
      case 'withdraw':
        message = `Processing outflow of ${amount} ${currency} from your account`;
        break;
      case 'exchange':
        message = `Converting ${amount} ${currency} to ${details?.toCurrency || 'another currency'}`;
        if (details?.convertedAmount) {
          message += `. You will receive ${details.convertedAmount} ${details.toCurrency}`;
        }
        break;
      case 'transfer':
        message = `Transferring ${amount} ${currency}`;
        break;
      default:
        message = `Processing ${type} transaction for ${amount} ${currency}`;
    }
    
    speak(message, 'high');
  }, [speak]);

  const narrateBalance = useCallback((currency: string, balance: string, usdValue?: string) => {
    let message = `Your ${currency} balance is ${balance}`;
    if (usdValue) {
      message += `. Worth approximately ${usdValue} US dollars`;
    }
    speak(message, 'medium');
  }, [speak]);

  const narrateSuccess = useCallback((message: string) => {
    speak(`Success: ${message}`, 'high');
  }, [speak]);

  const narrateError = useCallback((message: string) => {
    speak(`Error: ${message}`, 'high');
  }, [speak]);

  const narrateNavigation = useCallback((location: string) => {
    speak(`Navigating to ${location}`, 'low');
  }, [speak]);

  // Voice command recognition
  const startListening = useCallback(() => {
    if (!isSupported || !settings.voiceCommands) return;

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';
    
    recognition.onstart = () => {
      setIsListening(true);
      speak('Voice commands activated', 'low');
    };
    
    recognition.onend = () => {
      setIsListening(false);
    };
    
    recognition.onerror = (event: any) => {
      console.error('Speech recognition error:', event.error);
      setIsListening(false);
    };
    
    recognition.onresult = (event: any) => {
      const transcript = event.results[event.results.length - 1][0].transcript.toLowerCase();
      console.log('Voice command:', transcript);
      
      // Process voice commands
      if (transcript.includes('balance')) {
        speak('Reading your account balances', 'high');
        // This would trigger balance narration
      } else if (transcript.includes('help')) {
        speak('Available commands: say balance to hear your balances, say inflow to record an inflow, say outflow to record an outflow, say transfer to transfer funds', 'high');
      }
    };
    
    recognition.start();
    return recognition;
  }, [isSupported, settings.voiceCommands, speak]);

  const stopListening = useCallback(() => {
    setIsListening(false);
    speechSynthesis.cancel();
  }, []);

  return {
    isSupported,
    isListening,
    voices,
    settings,
    updateSettings,
    speak,
    narrateTransaction,
    narrateBalance,
    narrateSuccess,
    narrateError,
    narrateNavigation,
    startListening,
    stopListening,
  };
}