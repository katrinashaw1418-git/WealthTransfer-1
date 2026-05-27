import { Link } from "wouter";
import { CheckCircle, LogIn, Home, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Signout() {
  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-md text-center space-y-8">

        {/* Branding */}
        <div className="space-y-1">
          <div className="flex items-center justify-center gap-3 mb-2">
            <img src="/amax-coin-icon.png" alt="AMAX GLOBAL" className="h-10 w-auto" />
            <span className="font-bold text-white text-2xl tracking-widest">AMAX GLOBAL</span>
          </div>
          <p className="text-slate-400 text-sm">AUSTRAC Registered DCE · ABN 54 690 827 608</p>
        </div>

        {/* Signed-out card */}
        <div className="bg-slate-800 border border-slate-700 rounded-2xl px-8 py-10 shadow-xl space-y-5">
          <div className="flex justify-center">
            <div className="w-16 h-16 rounded-full bg-green-900/40 border border-green-700/50 flex items-center justify-center">
              <CheckCircle className="w-8 h-8 text-green-400" />
            </div>
          </div>

          <div className="space-y-2">
            <h1 className="text-xl font-semibold text-white">You've been signed out</h1>
            <p className="text-slate-400 text-sm leading-relaxed">
              Your session has been terminated and your credentials cleared from this device.
            </p>
          </div>

          <div className="flex items-start gap-2.5 bg-slate-700/50 rounded-lg px-4 py-3 text-left">
            <Lock className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-slate-400 leading-relaxed">
              For your security, all authenticated API access has been revoked. Close this browser tab
              if you are using a shared or public device.
            </p>
          </div>

          <div className="flex flex-col gap-3 pt-1">
            <Link href="/login">
              <Button className="w-full bg-amber-500 hover:bg-amber-600 text-slate-900 font-semibold" size="lg">
                <LogIn className="w-4 h-4 mr-2" />
                Sign In Again
              </Button>
            </Link>
            <Link href="/">
              <Button variant="ghost" className="w-full text-slate-400 hover:text-white hover:bg-slate-700" size="lg">
                <Home className="w-4 h-4 mr-2" />
                Return to Home
              </Button>
            </Link>
          </div>
        </div>

        {/* Footer */}
        <div className="space-y-1">
          <p className="text-slate-500 text-xs">
            AMAX GLOBAL Pty Ltd · +61 2 8320 1908
          </p>
          <p className="text-slate-600 text-xs">
            <a href="mailto:info@amaxglobal.com.au" className="hover:text-slate-400 transition-colors">
              info@amaxglobal.com.au
            </a>
            {" · "}
            <Link href="/privacy-policy">
              <span className="hover:text-slate-400 transition-colors cursor-pointer">Privacy Policy</span>
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
