import { useState } from "react";
import Sidebar from "./sidebar";
import Header from "./header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Phone, MessageCircle, X } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import WriteKillSwitchBanner from "@/components/write-kill-switch-banner";
import { ComplianceShell } from "@/components/layout/ComplianceShell";
import { useLocation } from "wouter";

interface LayoutProps {
  children: React.ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const [location] = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showAdvisorBox, setShowAdvisorBox] = useState(true);
  const [advisorModalOpen, setAdvisorModalOpen] = useState(false);
  const [advisorMessage, setAdvisorMessage] = useState('');
  const { toast } = useToast();

  const advisorMutation = useMutation({
    mutationFn: async (data: { message: string }) => {
      const response = await apiRequest("POST", "/api/advisor/contact", data);
      if (!response.ok) throw new Error('Failed to send message');
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Message Sent", description: "Your adviser will contact you within 24 hours." });
      setAdvisorModalOpen(false);
      setAdvisorMessage('');
    },
    onError: () => {
      toast({ title: "Message Failed", description: "Please try again later.", variant: "destructive" });
    }
  });

  const showAiDisclaimer = location === "/ai-insights";
  // Slice 4 — investor hub: same record-retention footer line on all six primary pages
  // (plus /compliance if routed again).
  const investorRetentionHub = new Set([
    "/dashboard",
    "/portfolio",
    "/ai-insights",
    "/goals",
    "/reports",
    "/account",
    "/compliance",
  ]);
  const showRetentionStatement = investorRetentionHub.has(location);

  return (
    <div className="flex min-h-screen bg-neutral-50">
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex-1 flex flex-col lg:ml-64">
        {/* Task #155 — global "temporarily read-only" banner. Renders
            nothing when the kill switch is off; appears within ~30s when
            an admin flips the switch. */}
        <WriteKillSwitchBanner />
        <Header onMenuClick={() => setSidebarOpen(true)} />
        <main className="flex-1 overflow-y-auto">
          <ComplianceShell
            showAiDisclaimer={showAiDisclaimer}
            showRetentionStatement={showRetentionStatement}
          >
            {children}
          </ComplianceShell>
        </main>
      </div>

      {showAdvisorBox && (
        <div className="fixed top-4 right-4 z-50">
          <Card className="w-72 shadow-2xl border-0 bg-white/95 backdrop-blur-lg">
            <CardHeader className="pb-3 relative">
              <CardTitle className="text-lg">Contact Your Advisor</CardTitle>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAdvisorBox(false)}
                className="absolute top-2 right-2 h-6 w-6 p-0 hover:bg-gray-100"
              >
                <X className="w-4 h-4" />
              </Button>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="bg-sky-50 p-3 rounded-lg border border-sky-100">
                  <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 bg-sky-500 rounded-full flex items-center justify-center">
                      <Phone className="w-4 h-4 text-white" />
                    </div>
                    <div>
                      <p className="text-xs text-sky-700 font-medium">+61 2 8320 1908</p>
                    </div>
                  </div>
                </div>
                <div className="flex space-x-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => window.open('tel:+61283201908')}
                    className="flex-1 text-xs hover:bg-sky-50 border-sky-200 text-sky-700"
                  >
                    <Phone className="w-3 h-3 mr-1" />
                    Call
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => setAdvisorModalOpen(true)}
                    className="flex-1 text-xs bg-sky-500 hover:bg-sky-600 text-white"
                  >
                    <MessageCircle className="w-3 h-3 mr-1" />
                    Message
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <Dialog open={advisorModalOpen} onOpenChange={setAdvisorModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Contact Wealth Advisory Team</DialogTitle>
            <DialogDescription>
              Send a message to our wealth advisory team. We'll respond within 24 hours.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="bg-blue-50 p-3 rounded-lg border border-blue-200">
              <p className="text-sm text-blue-700">
                <strong>Phone:</strong> +61 2 8320 1908
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="advisor-message-global">Your Message</Label>
              <Textarea
                id="advisor-message-global"
                placeholder="How can our wealth advisory team help you?"
                value={advisorMessage}
                onChange={(e) => setAdvisorMessage(e.target.value)}
                rows={4}
                className="resize-none"
              />
            </div>
            <div className="flex justify-end space-x-2">
              <Button variant="outline" onClick={() => setAdvisorModalOpen(false)}>Cancel</Button>
              <Button
                onClick={() => advisorMutation.mutate({ message: advisorMessage })}
                disabled={advisorMutation.isPending || !advisorMessage.trim()}
              >
                {advisorMutation.isPending ? "Sending..." : "Send Message"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
