import { useState, useMemo, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/contexts/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Shield,
  CheckCircle,
  Clock,
  AlertTriangle,
  Upload,
  FileText,
  User,
  MapPin,
  Building,
  RefreshCw,
  Lock,
  Camera,
  BookOpen,
  PenLine,
  FileCheck,
} from "lucide-react";

// ── helpers ───────────────────────────────────────────────────────────────────
const statusColor = (s: string) => {
  switch (s) {
    case "completed": case "approved":       return "bg-green-100 text-green-800";
    case "in_progress": case "under_review": return "bg-yellow-100 text-yellow-800";
    case "pending":                          return "bg-gray-100 text-gray-800";
    case "rejected":                         return "bg-red-100 text-red-800";
    default:                                 return "bg-gray-100 text-gray-800";
  }
};

const statusLabel = (s: string) =>
  s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

type StepStatus = "completed" | "under_review" | "in_progress" | "pending";

const kycStepDefs: { id: number; title: string; icon: any; uploadId: string | null }[] = [
  { id: 1, title: "Personal Information",  icon: User,       uploadId: null },
  { id: 2, title: "Customer Agreement",    icon: BookOpen,   uploadId: null },
  { id: 3, title: "Identity Verification", icon: Camera,     uploadId: null },
  { id: 4, title: "Proof of Address",      icon: MapPin,     uploadId: "kyc-upload-4" },
];

// ── main ─────────────────────────────────────────────────────────────────────
export default function Compliance() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState("kyc");

  // which steps have had files uploaded (stepId → filename)
  const [stepFiles, setStepFiles] = useState<Record<number, string>>({});



  // ── Step 1: Personal Info (KYC Profile) ───────────────────────────────────
  const [piiFullName,        setPiiFullName]        = useState("");
  const [piiDob,             setPiiDob]             = useState("");
  const [piiNationality,     setPiiNationality]     = useState("");
  const [piiPhone,           setPiiPhone]           = useState("");
  // Address
  const [piiAddress,         setPiiAddress]         = useState("");
  const [piiSuburb,          setPiiSuburb]          = useState("");
  const [piiStateRegion,     setPiiStateRegion]     = useState("");
  const [piiPostcode,        setPiiPostcode]        = useState("");
  const [piiAddrCountry,     setPiiAddrCountry]     = useState("Australia");
  // Employment & financial profile
  const [piiEmployment,      setPiiEmployment]      = useState("");
  const [piiOccupation,      setPiiOccupation]      = useState("");
  const [piiPurpose,         setPiiPurpose]         = useState("");
  const [piiSourceFunds,     setPiiSourceFunds]     = useState("");
  const [piiTaxCountry,      setPiiTaxCountry]      = useState("");

  // ── Step 3: Customer Agreement ─────────────────────────────────────────────
  const [signatureName,  setSignatureName]  = useState("");
  const [sectionsRead,   setSectionsRead]   = useState<Set<number>>(new Set());
  const agreementScrollRef = useRef<HTMLDivElement>(null);
  const sectionRefs        = useRef<(HTMLDivElement | null)[]>([]);
  const allSectionsRead    = sectionsRead.size >= 18;

  // ── Step 2: Identity document + biometric verification ────────────────────
  const [docType,          setDocType]          = useState<"passport" | "driver_licence" | "national_id">("passport");
  const [docExpiry,        setDocExpiry]        = useState("");           // YYYY-MM-DD from date input
  const [docIssueCountry,  setDocIssueCountry]  = useState("");           // issuing country (passport risk scoring)
  const [editStep1, setEditStep1] = useState(false); // allow re-editing step 1 after completion
  const [editStep2, setEditStep2] = useState(false); // allow re-editing step 2 after completion
  const [editStep3, setEditStep3] = useState(false); // allow re-submitting identity docs from under_review
  const [idVerifyComplete,  setIdVerifyComplete]  = useState(false);
  const [idDocsSubmitted,   setIdDocsSubmitted]   = useState(false); // true when Sumsub SDK complete → "under_review"
  const [addressDocApproved, setAddressDocApproved] = useState(false); // true when Sumsub/admin approves POA → "completed"
  // Sumsub integration state
  type VerifyMode = "idle" | "loading" | "sumsub_sdk" | "manual_review" | "approved" | "declined";
  const [verifyMode,          setVerifyMode]         = useState<VerifyMode>("idle");
  const [sumsubToken,         setSumsubToken]         = useState<string>("");
  const [addrVerifyMode,      setAddrVerifyMode]      = useState<VerifyMode>("idle");
  const [addrSumsubToken,     setAddrSumsubToken]     = useState<string>("");
  const [addrDocsSubmitted,   setAddrDocsSubmitted]   = useState(false); // true when Sumsub SDK signals docs uploaded

  const { data: kycProfile, refetch: refetchProfile } = useQuery<{
    kycProfileComplete: boolean;
    idDocsSubmitted: boolean;
    idVerificationComplete: boolean;
    addressDocFilename?: string | null;
    addressDocApproved: boolean;
    fullLegalName?: string;
    dateOfBirth?: string;
    nationality?: string;
    phoneNumber?: string;
    residentialAddress?: string;
    suburb?: string;
    stateRegion?: string;
    postcode?: string;
    addressCountry?: string;
    occupation?: string;
    employmentStatus?: string;
    purposeOfAccount?: string;
    sourceOfFunds?: string;
    taxCountry?: string;
    kycRefreshDue?: string | null;
    agreementSigned?: boolean;
    agreementSignedAt?: string | null;
    agreementRef?: string | null;
    agreementSignature?: string | null;
    agreementVersion?: string | null;
  }>({
    queryKey: ["/api/kyc/profile"],
  });

  const profileMutation = useMutation({
    mutationFn: (payload: any) => apiRequest("PUT", "/api/kyc/profile", payload),
    onSuccess: () => {
      if (editStep1 && kycProfile?.kycProfileComplete) {
        toast({ title: "Details Updated", description: "Your contact and financial profile has been saved successfully." });
      } else {
        toast({ title: "Personal Information Saved", description: "Your profile has been submitted. Please continue to the next step." });
      }
      setEditStep1(false);
      refetchProfile();
      queryClient.invalidateQueries({ queryKey: ["/api/kyc/profile"] });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message ?? "Failed to save profile", variant: "destructive" });
    },
  });

  // ── Identity verification: start Sumsub session ────────────────────────────
  const identityMutation = useMutation({
    mutationFn: (payload: { documentType: string; documentExpiry?: string; issueCountry?: string }) =>
      apiRequest("POST", "/api/kyc/identity/start", payload),
    onSuccess: async (res: any) => {
      const data = await res.json();
      if (data.mode === "sumsub") {
        setSumsubToken(data.token);
        setVerifyMode("sumsub_sdk");
      } else {
        // No Sumsub credentials — manual review queued
        setVerifyMode("manual_review");
        toast({
          title: "Identity Documents Received",
          description: "Your documents have been queued for manual review by our compliance team. You will be notified within 1–2 business days.",
        });
      }
    },
    onError: (err: any) => {
      setVerifyMode("idle");
      toast({ title: "Verification Error", description: err.message ?? "Failed to start identity verification. Please try again.", variant: "destructive" });
    },
  });

  // ── Customer Agreement signing mutation ────────────────────────────────────
  const agreementMutation = useMutation({
    mutationFn: (payload: { signature: string; pepDeclaration: boolean }) =>
      apiRequest("POST", "/api/kyc/agreement/sign", payload),
    onSuccess: async (res: any) => {
      const data = await res.json();
      toast({ title: "Agreement Signed", description: `Customer agreement signed — ref ${data.agreementRef}` });
      setEditStep2(false);
      refetchProfile();
      queryClient.invalidateQueries({ queryKey: ["/api/kyc/profile"] });
    },
    onError: (err: any) => {
      toast({ title: "Signing Failed", description: err.message ?? "Failed to record your signature. Please try again.", variant: "destructive" });
    },
  });

  // ── Identity verification reset (re-verify from under_review OR completed) ──
  const identityResetMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/kyc/identity/reset", {}),
    onSuccess: () => {
      setIdDocsSubmitted(false);
      setIdVerifyComplete(false);
      setEditStep3(false);
      setVerifyMode("idle");
      setDocExpiry("");
      setDocIssueCountry("");
      refetchProfile();
      queryClient.invalidateQueries({ queryKey: ["/api/kyc/profile"] });
      toast({ title: "Re-verification Unlocked", description: "You can now re-submit your identity documents via Sumsub. Please use a clear, in-date government-issued ID." });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message ?? "Failed to reset identity status", variant: "destructive" });
    },
  });

  // ── Address verification reset (re-verify from under_review OR completed) ───
  const addressResetMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/kyc/address/reset", {}),
    onSuccess: () => {
      setAddressDocApproved(false);
      setAddrDocsSubmitted(false);
      setAddrVerifyMode("idle");
      setStepFiles(prev => ({ ...prev, 4: "" }));
      refetchProfile();
      queryClient.invalidateQueries({ queryKey: ["/api/kyc/profile"] });
      toast({ title: "Re-verification Unlocked", description: "You can now re-submit your proof of address via Sumsub." });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message ?? "Failed to reset address status", variant: "destructive" });
    },
  });

  // ── Address verification: start Sumsub POA session ────────────────────────
  const addressStartMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/kyc/address/start", {}),
    onSuccess: async (res: any) => {
      const data = await res.json();
      if (data.mode === "sumsub") {
        setAddrSumsubToken(data.token);
        setAddrVerifyMode("sumsub_sdk");
      } else {
        setAddrVerifyMode("manual_review");
        setAddrDocsSubmitted(true);
        setStepFiles(prev => ({ ...prev, [4]: "manual-pending" }));
        refetchProfile();
        toast({
          title: "Address Verification Queued",
          description: "Your address verification has been queued for review by our compliance team. You will be notified within 1–2 business days.",
        });
      }
    },
    onError: (err: any) => {
      setAddrVerifyMode("idle");
      toast({ title: "Verification Error", description: err.message ?? "Failed to start address verification. Please try again.", variant: "destructive" });
    },
  });

  // ── Agreement scroll tracking — marks sections as read on scroll ──────────
  function handleAgreementScroll() {
    const container = agreementScrollRef.current;
    if (!container) return;
    const containerBottom = container.getBoundingClientRect().bottom;
    const newRead = new Set(sectionsRead);
    sectionRefs.current.forEach((el, idx) => {
      if (!el) return;
      const elBottom = el.getBoundingClientRect().bottom;
      if (elBottom <= containerBottom + 40) newRead.add(idx + 1);
    });
    setSectionsRead(newRead);
  }

  // ── Poll /api/kyc/identity/status while Sumsub SDK is active ─────────────
  const { data: idStatusData } = useQuery<{ complete: boolean; documentType: string | null }>({
    queryKey: ["/api/kyc/identity/status"],
    refetchInterval: verifyMode === "sumsub_sdk" ? 5000 : false,
    enabled: verifyMode === "sumsub_sdk" || verifyMode === "manual_review",
  });

  useEffect(() => {
    if (idStatusData?.complete && !idVerifyComplete) {
      setIdVerifyComplete(true);
      setVerifyMode("approved");
      toast({ title: "Identity Verified", description: "Your identity has been successfully verified. You may now proceed to the next step." });
    }
  }, [idStatusData?.complete]);

  // ── Seed idVerifyComplete from DB on profile load ─────────────────────────
  useEffect(() => {
    if (kycProfile?.idVerificationComplete && !idVerifyComplete) {
      setIdVerifyComplete(true);
      if (verifyMode === "idle") setVerifyMode("approved");
    }
  }, [kycProfile?.idVerificationComplete]);

  // ── Seed idDocsSubmitted from DB ───────────────────────────────────────────
  useEffect(() => {
    if (kycProfile?.idDocsSubmitted && !idDocsSubmitted) {
      setIdDocsSubmitted(true);
    }
  }, [kycProfile?.idDocsSubmitted]);

  // ── Seed addressDocApproved from DB ───────────────────────────────────────
  useEffect(() => {
    if (kycProfile?.addressDocApproved && !addressDocApproved) {
      setAddressDocApproved(true);
    }
  }, [kycProfile?.addressDocApproved]);

  // ── Seed addrDocsSubmitted + stepFiles[4] from DB addressDocFilename ───────
  useEffect(() => {
    const f = kycProfile?.addressDocFilename;
    if (f) {
      if (!stepFiles[4]) setStepFiles(prev => ({ ...prev, 4: f }));
      if (f === "sumsub-submitted" || f === "manual-pending") setAddrDocsSubmitted(true);
    }
  }, [kycProfile?.addressDocFilename]);

  // ── Poll /api/kyc/address/status while Sumsub POA SDK is active ───────────
  const { data: addrStatusData } = useQuery<{ complete: boolean; submitted: boolean }>({
    queryKey: ["/api/kyc/address/status"],
    refetchInterval: addrVerifyMode === "sumsub_sdk" ? 5000 : false,
    enabled: addrVerifyMode === "sumsub_sdk" || addrVerifyMode === "manual_review",
  });

  useEffect(() => {
    if (addrStatusData?.complete && !addressDocApproved) {
      setAddressDocApproved(true);
      setAddrVerifyMode("approved");
      toast({ title: "Address Verified", description: "Your proof of address has been successfully verified by Sumsub." });
      refetchProfile();
      queryClient.invalidateQueries({ queryKey: ["/api/kyc/profile"] });
    }
  }, [addrStatusData?.complete]);

  // ── Launch Sumsub WebSDK for address (POA) ─────────────────────────────────
  useEffect(() => {
    if (addrVerifyMode !== "sumsub_sdk" || !addrSumsubToken) return;

    const SUMSUB_SDK_URL  = "https://static.sumsub.com/idensic/static/sns-websdk-builder.js";
    const CONTAINER_ID    = "sumsub-address-websdk-container";
    const SCRIPT_ID       = "sumsub-address-websdk-script";

    function launchAddressSdk() {
      const sdk = (window as any).SumsubWebSdk;
      if (!sdk) return;
      sdk
        .init(addrSumsubToken, async () => {
          try {
            const r = await fetch("/api/kyc/address/refresh-token", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
            });
            const d = await r.json();
            return d.token ?? "";
          } catch { return ""; }
        })
        .withConf({ lang: "en", uiConf: { customCssStr: "" } })
        .withOptions({ addViewportTag: false, adaptIframeHeight: true })
        .on("onStepCompleted", () => {
          fetch("/api/kyc/address/docs-submitted", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
          });
          setAddrDocsSubmitted(true);
          setStepFiles(prev => ({ ...prev, [4]: "sumsub-submitted" }));
          toast({
            title: "Documents Submitted",
            description: "Your proof of address has been submitted to Sumsub for automated review. This typically takes a few minutes.",
          });
        })
        .on("onApplicantSubmitted", () => {
          fetch("/api/kyc/address/docs-submitted", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
          }).then(() => {
            setAddrDocsSubmitted(true);
            setStepFiles(prev => ({ ...prev, [4]: "sumsub-submitted" }));
            refetchProfile();
          });
        })
        .on("onError", (error: any) => {
          console.error("[Sumsub POA] error:", error);
        })
        .build()
        .launch(`#${CONTAINER_ID}`);
    }

    if (document.getElementById(SCRIPT_ID)) {
      launchAddressSdk();
      return;
    }
    const script    = document.createElement("script");
    script.id       = SCRIPT_ID;
    script.src      = SUMSUB_SDK_URL;
    script.onload   = launchAddressSdk;
    document.head.appendChild(script);

    return () => { /* Keep script cached for reuse */ };
  }, [addrVerifyMode, addrSumsubToken]);

  // ── Pre-populate PII form from DB on profile load (needed for edit mode) ──
  useEffect(() => {
    if (!kycProfile) return;
    if (kycProfile.fullLegalName)      setPiiFullName(kycProfile.fullLegalName);
    if (kycProfile.dateOfBirth)        setPiiDob(kycProfile.dateOfBirth);
    if (kycProfile.nationality)        setPiiNationality(kycProfile.nationality);
    if (kycProfile.phoneNumber)        setPiiPhone(kycProfile.phoneNumber);
    if (kycProfile.residentialAddress) setPiiAddress(kycProfile.residentialAddress);
    if (kycProfile.suburb)             setPiiSuburb(kycProfile.suburb);
    if (kycProfile.stateRegion)        setPiiStateRegion(kycProfile.stateRegion);
    if (kycProfile.postcode)           setPiiPostcode(kycProfile.postcode);
    if (kycProfile.addressCountry)     setPiiAddrCountry(kycProfile.addressCountry);
    if (kycProfile.employmentStatus)   setPiiEmployment(kycProfile.employmentStatus);
    if (kycProfile.occupation)         setPiiOccupation(kycProfile.occupation);
    if (kycProfile.purposeOfAccount)   setPiiPurpose(kycProfile.purposeOfAccount);
    if (kycProfile.sourceOfFunds)      setPiiSourceFunds(kycProfile.sourceOfFunds);
    if (kycProfile.taxCountry)         setPiiTaxCountry(kycProfile.taxCountry);
  }, [kycProfile]);

  // ── Load and launch Sumsub WebSDK when mode becomes sumsub_sdk ─────────────
  useEffect(() => {
    if (verifyMode !== "sumsub_sdk" || !sumsubToken) return;

    const SUMSUB_SDK_URL = "https://static.sumsub.com/idensic/static/sns-websdk-builder.js";
    const CONTAINER_ID   = "sumsub-websdk-container";
    const SCRIPT_ID      = "sumsub-websdk-script";

    const launch = () => {
      const sdk = (window as any).SumsubWebSdk;
      if (!sdk) return;

      sdk
        .init(sumsubToken, async () => {
          // Token refresh callback — called by SDK when current token is about to expire
          try {
            const res = await fetch("/api/kyc/identity/refresh-token", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
            });
            const d = await res.json();
            return d.token ?? "";
          } catch {
            return "";
          }
        })
        .withConf({ lang: "en" })
        .withOptions({ addViewportMeta: true })
        .on("idCheck.onApplicantStatusChanged", (payload: any) => {
          const answer = payload?.reviewResult?.reviewAnswer;
          if (answer === "GREEN") {
            setIdVerifyComplete(true);
            setVerifyMode("approved");
            toast({ title: "Identity Verified", description: "Your identity has been successfully verified." });
          } else if (answer === "RED") {
            setVerifyMode("declined");
          } else {
            // Docs submitted to Sumsub — now "under_review" waiting for their decision
            if (!idDocsSubmitted) {
              setIdDocsSubmitted(true);
              fetch("/api/kyc/identity/docs-submitted", {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
              }).catch(() => {});
              toast({
                title: "Documents Submitted",
                description: "Your identity documents have been sent to Sumsub for review. This typically takes 1–2 business days.",
              });
            }
          }
        })
        .on("idCheck.onComplete", () => {
          // Fired when user completes the entire SDK flow — ensure docs-submitted is recorded
          if (!idDocsSubmitted) {
            setIdDocsSubmitted(true);
            fetch("/api/kyc/identity/docs-submitted", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
            }).catch(() => {});
          }
        })
        .on("idCheck.onError", (error: any) => {
          console.error("[Sumsub] error:", error);
          toast({ title: "Verification Error", description: "An error occurred during identity verification. Please try again.", variant: "destructive" });
          setVerifyMode("idle");
        })
        .build()
        .launch(`#${CONTAINER_ID}`);
    };

    if (document.getElementById(SCRIPT_ID)) {
      launch();
    } else {
      const script    = document.createElement("script");
      script.id       = SCRIPT_ID;
      script.src      = SUMSUB_SDK_URL;
      script.onload   = launch;
      script.onerror  = () => {
        toast({ title: "Network Error", description: "Failed to load the identity verification SDK. Please check your connection and try again.", variant: "destructive" });
        setVerifyMode("idle");
      };
      document.body.appendChild(script);
    }
  }, [verifyMode, sumsubToken]);

  function handleProfileSubmit() {
    // Identity fields only required when NOT already verified by Sumsub
    if (!idVerifyComplete && (!piiFullName || !piiDob || !piiNationality)) {
      toast({ title: "Identity Details Required", description: "Please complete your full legal name, date of birth, and nationality.", variant: "destructive" });
      return;
    }
    if (!piiPhone) {
      toast({ title: "Phone Required", description: "Please enter your mobile number.", variant: "destructive" });
      return;
    }
    if (!piiAddress || !piiSuburb || !piiPostcode) {
      toast({ title: "Address Required", description: "Please enter your full residential address (no PO Box).", variant: "destructive" });
      return;
    }
    if (!piiEmployment || !piiPurpose || !piiSourceFunds) {
      toast({ title: "Financial Profile Required", description: "Please select your employment status, purpose of account, and source of funds.", variant: "destructive" });
      return;
    }
    profileMutation.mutate({
      // Only send identity fields when not yet locked by verification
      ...(!idVerifyComplete && {
        fullLegalName: piiFullName,
        dateOfBirth: piiDob,
        nationality: piiNationality,
      }),
      phoneNumber: piiPhone,
      // pepDeclaration will be captured during Customer Agreement signing (Step 3)
      pepDeclaration: false,
      sanctionsDeclaration: false,
      consentDeclaration: false,
      residentialAddress: piiAddress,
      suburb: piiSuburb,
      stateRegion: piiStateRegion,
      postcode: piiPostcode,
      addressCountry: piiAddrCountry,
      occupation: piiOccupation,
      employmentStatus: piiEmployment,
      purposeOfAccount: piiPurpose,
      sourceOfFunds: piiSourceFunds,
      taxCountry: piiTaxCountry,
    });
  }

  // ── derive step statuses ───────────────────────────────────────────────────
  // Correct order per AUSTRAC best practice:
  // 1 Personal Info → 2 Declarations/Agreement → 3 ID Verify → 4 Address → 5 Funds
  const agreementSigned = kycProfile?.agreementSigned ?? false;
  const profileDone = kycProfile?.kycProfileComplete ?? false;
  const stepStatuses = useMemo((): Record<number, StepStatus> => {
    const s1: StepStatus = profileDone ? "completed" : "in_progress";
    const s2: StepStatus = !profileDone ? "pending" : agreementSigned ? "completed" : "in_progress";
    // Step 3: in_progress → under_review (docs sent to Sumsub) → completed (Sumsub approved)
    const s3: StepStatus = !agreementSigned ? "pending"
      : idVerifyComplete  ? "completed"
      : idDocsSubmitted   ? "under_review"
      : "in_progress";
    // Step 4: in_progress → under_review (doc uploaded) → completed (admin approved)
    const s4: StepStatus = !agreementSigned ? "pending"
      : addressDocApproved            ? "completed"
      : (stepFiles[4] || kycProfile?.addressDocFilename) ? "under_review"
      : "in_progress";
    return { 1: s1, 2: s2, 3: s3, 4: s4 };
  }, [profileDone, agreementSigned, idVerifyComplete, idDocsSubmitted, addressDocApproved, stepFiles, kycProfile?.addressDocFilename]);

  const currentStepId = useMemo(() => {
    if (!profileDone) return 1;
    if (!agreementSigned) return 2;
    // Step 3 active only while docs not yet submitted (in_progress) or after re-attempt (declined)
    if (!idDocsSubmitted && !idVerifyComplete) return 3;
    // Step 4 active while doc not yet approved
    if (!addressDocApproved) return 4;
    return null;
  }, [profileDone, agreementSigned, idDocsSubmitted, idVerifyComplete, addressDocApproved]);

  // KYC completion % — 25% per step
  const kycPct = useMemo(() => {
    let total = 0;
    if (profileDone)       total += 25;
    if (agreementSigned)   total += 25;
    if (idVerifyComplete)  total += 25;
    if (addressDocApproved) total += 25;
    return total;
  }, [profileDone, agreementSigned, idVerifyComplete, addressDocApproved]);

  // ── Compliance metrics grid (4 tiles) ─────────────────────────────────────
  const complianceMetrics = useMemo(() => [
    {
      label: "Personal Info",
      status: stepStatuses[1],
      value: profileDone ? 100 : 0,
    },
    {
      label: "Agreement",
      status: stepStatuses[2],
      value: agreementSigned ? 100 : profileDone ? 50 : 0,
    },
    {
      label: "Identity Check",
      status: stepStatuses[3],
      value: idVerifyComplete ? 100 : agreementSigned ? 30 : 0,
    },
    {
      label: "Documentation",
      status: stepStatuses[4],
      value: addressDocApproved ? 100 : (stepFiles[4] || kycProfile?.addressDocFilename) ? 50 : 0,
    },
  ], [stepStatuses, profileDone, agreementSigned, idVerifyComplete, addressDocApproved, stepFiles, kycProfile?.addressDocFilename]);

  // ── KYC refresh notice ─────────────────────────────────────────────────────
  const kycRefreshNotice = useMemo((): "overdue" | "due_soon" | null => {
    if (!kycProfile?.kycRefreshDue) return null;
    const due = new Date(kycProfile.kycRefreshDue);
    const now = new Date();
    const daysUntilDue = Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    if (daysUntilDue <= 0)  return "overdue";
    if (daysUntilDue <= 30) return "due_soon";
    return null;
  }, [kycProfile?.kycRefreshDue]);

  // ── handlers ──────────────────────────────────────────────────────────────
  function handleKycUpload(stepId: number, stepTitle: string, e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const filename = file.name;
    setStepFiles(prev => ({ ...prev, [stepId]: filename }));
    // Persist step 4 address document to DB so it survives page refresh
    if (stepId === 4) {
      fetch("/api/kyc/address/upload", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      }).catch(() => {});
    }
    toast({
      title: "Document Submitted for Review",
      description: `${filename} has been received for ${stepTitle}. Our compliance team will review it within 1–2 business days.`,
    });
    e.target.value = "";
  }


  function handleIdVerifySubmit() {
    setVerifyMode("loading");
    identityMutation.mutate({ documentType: docType });
  }



  // next step prompt — uses currentStepId so sequential steps 3→5 take priority
  // over step 2 (identity) which runs asynchronously in the background.
  const nextStep = currentStepId != null ? kycStepDefs.find(s => s.id === currentStepId) : undefined;

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div className="p-6 space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Compliance Centre</h1>
          <p className="text-gray-600 text-sm">
            AMAX GLOBAL Pty Ltd (ABN 54 690 827 608) — regulatory verification and document management
          </p>
        </div>
        {kycPct === 100 ? (
          <div className="flex items-center gap-3 px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center">
              <RefreshCw className="w-4 h-4 text-white" />
            </div>
            <div>
              <p className="text-sm font-semibold text-blue-800">Under Review</p>
              <p className="text-xs text-blue-600">All documents submitted — awaiting compliance approval</p>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 px-4 py-2 bg-yellow-50 border border-yellow-200 rounded-lg">
            <div className="w-8 h-8 bg-yellow-500 rounded-lg flex items-center justify-center">
              <Clock className="w-4 h-4 text-white" />
            </div>
            <div>
              <p className="text-sm font-semibold text-yellow-800">Verification In Progress</p>
              <p className="text-xs text-yellow-600">KYC {kycPct}% complete</p>
            </div>
          </div>
        )}
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {complianceMetrics.map((metric, idx) => (
          <Card key={idx}>
            <CardContent className="p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide">{metric.label}</h3>
                <Badge className={statusColor(metric.status)}>{statusLabel(metric.status)}</Badge>
              </div>
              <span className="text-2xl font-bold">{metric.value}%</span>
              <Progress value={metric.value} className="h-1.5 mt-2" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
        <TabsList className="flex h-auto gap-1 bg-slate-100 p-1 rounded-lg w-full sm:w-auto">
          <TabsTrigger value="kyc"        className="flex-1 sm:flex-none text-xs sm:text-sm">KYC &amp; Documents</TabsTrigger>
          <TabsTrigger value="regulatory" className="flex-1 sm:flex-none text-xs sm:text-sm">Regulatory</TabsTrigger>
        </TabsList>

        {/* ── KYC Status Tab ── */}
        <TabsContent value="kyc" className="space-y-4">

          {/* ── KYC Refresh Notification ── */}
          {kycRefreshNotice === "overdue" && (
            <div className="flex items-start gap-3 p-4 rounded-xl border border-red-300 bg-red-50">
              <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-red-800 text-sm">KYC Review Overdue</p>
                <p className="text-sm text-red-700 mt-0.5">
                  Your scheduled KYC review date has passed. Under AUSTRAC CDD obligations, periodic customer
                  review is required. Please contact{" "}
                  <a href="mailto:info@amaxglobal.com.au" className="underline font-medium">info@amaxglobal.com.au</a>
                  {" "}to arrange your review or re-submit your information using the form below.
                </p>
              </div>
            </div>
          )}
          {kycRefreshNotice === "due_soon" && (
            <div className="flex items-start gap-3 p-4 rounded-xl border border-amber-300 bg-amber-50">
              <RefreshCw className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-amber-800 text-sm">KYC Review Due Soon</p>
                <p className="text-sm text-amber-700 mt-0.5">
                  Your periodic KYC review is due within the next 30 days (due:{" "}
                  {new Date(kycProfile!.kycRefreshDue!).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })}).
                  Please update your details or contact{" "}
                  <a href="mailto:info@amaxglobal.com.au" className="underline font-medium">info@amaxglobal.com.au</a>.
                </p>
              </div>
            </div>
          )}

          {/* ── Step 1: Personal Information (mandatory first step) ── */}
          {kycProfile?.kycProfileComplete && !editStep1 ? (
            <div className="border-2 border-green-200 bg-green-50 rounded-xl overflow-hidden">
              {/* Header row */}
              <div className="flex items-center gap-3 px-4 pt-4 pb-3 border-b border-green-100">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 bg-green-600">
                  <CheckCircle className="w-5 h-5 text-white" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-gray-400 font-medium">Step 1 of 4</span>
                    <h3 className="font-semibold text-gray-900">Personal Information</h3>
                    <Badge className="bg-green-100 text-green-800 text-xs">Completed</Badge>
                  </div>
                </div>
              </div>

              <div className="px-4 pb-4">
                <div className="bg-white border border-green-200 rounded-xl overflow-hidden">

                  {/* ── SECTION A: Identity — locked after Step 3 verified ── */}
                  <div className={`p-4 ${idVerifyComplete ? "bg-gray-50" : ""}`}>
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Identity</p>
                      {idVerifyComplete ? (
                        <span className="flex items-center gap-1 text-xs text-gray-500 bg-gray-200 px-2.5 py-0.5 rounded-full font-medium">
                          <Lock className="w-3 h-3" /> Verified · Sumsub
                        </span>
                      ) : (
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setEditStep1(true)}>
                          <PenLine className="w-3 h-3 mr-1" /> Edit
                        </Button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
                      <div><p className="text-xs text-gray-400">Full Legal Name</p><p className="font-medium text-gray-800">{kycProfile.fullLegalName || "—"}</p></div>
                      <div><p className="text-xs text-gray-400">Date of Birth</p><p className="font-medium text-gray-800">{kycProfile.dateOfBirth ? new Date(kycProfile.dateOfBirth).toLocaleDateString("en-AU") : "—"}</p></div>
                      <div><p className="text-xs text-gray-400">Nationality</p><p className="font-medium text-gray-800">{kycProfile.nationality || "—"}</p></div>
                      <div><p className="text-xs text-gray-400">Mobile Number</p><p className="font-medium text-gray-800">{kycProfile.phoneNumber || "—"}</p></div>
                    </div>
                    {idVerifyComplete && (
                      <p className="text-xs text-gray-400 mt-3 flex items-start gap-1">
                        <Lock className="w-3 h-3 flex-shrink-0 mt-0.5" />
                        Verified identity is locked. Contact{" "}
                        <a href="mailto:compliance@amaxglobal.com.au" className="underline ml-0.5">compliance@amaxglobal.com.au</a>{" "}
                        to request changes.
                      </p>
                    )}
                  </div>

                  <div className="border-t border-gray-100" />

                  {/* ── SECTION B: Residential Address — always editable ── */}
                  <div className="p-4">
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Residential Address</p>
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setEditStep1(true)}>
                        <PenLine className="w-3 h-3 mr-1" /> Edit
                      </Button>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
                      <div className="sm:col-span-2"><p className="text-xs text-gray-400">Street Address</p><p className="font-medium text-gray-800">{kycProfile.residentialAddress || "—"}</p></div>
                      <div><p className="text-xs text-gray-400">Suburb / City</p><p className="font-medium text-gray-800">{kycProfile.suburb || "—"}</p></div>
                      <div><p className="text-xs text-gray-400">State / Region</p><p className="font-medium text-gray-800">{kycProfile.stateRegion || "—"}</p></div>
                      <div><p className="text-xs text-gray-400">Postcode</p><p className="font-medium text-gray-800">{kycProfile.postcode || "—"}</p></div>
                      <div><p className="text-xs text-gray-400">Country</p><p className="font-medium text-gray-800">{kycProfile.addressCountry || "—"}</p></div>
                    </div>
                  </div>

                  <div className="border-t border-gray-100" />

                  {/* ── SECTION C: Financial Profile — always editable ── */}
                  <div className="p-4">
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Financial Profile</p>
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setEditStep1(true)}>
                        <PenLine className="w-3 h-3 mr-1" /> Edit
                      </Button>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
                      <div><p className="text-xs text-gray-400">Employment Status</p><p className="font-medium text-gray-800 capitalize">{kycProfile.employmentStatus?.replace(/_/g, " ") || "—"}</p></div>
                      <div><p className="text-xs text-gray-400">Occupation</p><p className="font-medium text-gray-800">{kycProfile.occupation || "—"}</p></div>
                      <div><p className="text-xs text-gray-400">Purpose of Account</p><p className="font-medium text-gray-800 capitalize">{kycProfile.purposeOfAccount?.replace(/_/g, " ") || "—"}</p></div>
                      <div><p className="text-xs text-gray-400">Source of Funds</p><p className="font-medium text-gray-800 capitalize">{kycProfile.sourceOfFunds?.replace(/_/g, " ") || "—"}</p></div>
                      <div><p className="text-xs text-gray-400">Tax Residency</p><p className="font-medium text-gray-800">{kycProfile.taxCountry || "—"}</p></div>
                    </div>
                  </div>

                  <div className="border-t border-gray-100 px-4 py-2.5 bg-gray-50">
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Lock className="w-3 h-3" /> Stored encrypted · AML/CTF CDD record · Privacy Act 1988
                    </p>
                  </div>

                </div>
              </div>
            </div>
          ) : (
            <div className={`rounded-2xl border-2 bg-white overflow-hidden shadow-sm ${editStep1 && kycProfile?.kycProfileComplete ? "border-green-300" : "border-blue-300"}`}>

              {/* Card top bar */}
              <div className={`px-5 py-4 ${editStep1 && kycProfile?.kycProfileComplete ? "bg-gradient-to-r from-green-600 to-green-700" : "bg-gradient-to-r from-blue-600 to-blue-700"}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center flex-shrink-0">
                      {editStep1 && kycProfile?.kycProfileComplete
                        ? <CheckCircle className="w-4 h-4 text-white" />
                        : <User className="w-4 h-4 text-white" />
                      }
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-white font-semibold text-sm">Step 1 of 4 — Personal Information</p>
                        {editStep1 && kycProfile?.kycProfileComplete && (
                          <span className="bg-white/20 text-white text-xs px-2 py-0.5 rounded-full font-medium">Completed · Editing</span>
                        )}
                      </div>
                      <p className={`text-xs mt-0.5 ${editStep1 && kycProfile?.kycProfileComplete ? "text-green-200" : "text-blue-200"}`}>
                        {editStep1 && kycProfile?.kycProfileComplete ? "Update your information below then save" : "Takes about 3 minutes · Required by AUSTRAC"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 bg-white/10 rounded-full px-3 py-1">
                    <Lock className="w-3 h-3 text-white/70" />
                    <span className="text-white/70 text-xs font-medium">Encrypted</span>
                  </div>
                </div>
                {/* Mini step dots */}
                <div className="flex items-center gap-1.5 mt-3">
                  {[1,2,3,4,5].map(n => (
                    <div key={n} className={`h-1.5 rounded-full transition-all ${n === 1 ? "bg-white flex-1" : "bg-white/30 w-6"}`} />
                  ))}
                </div>
              </div>

              <div className="p-5 space-y-5">

                {/* Section A — Identity (locked after Step 3 identity verification) */}
                {idVerifyComplete ? (
                  <div className="rounded-xl bg-gray-50 border border-gray-200 p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <Lock className="w-4 h-4 text-gray-500" />
                      <h4 className="text-sm font-semibold text-gray-800">Identity Details</h4>
                      <span className="ml-auto flex items-center gap-1 text-xs text-gray-500 bg-gray-200 px-2.5 py-0.5 rounded-full font-medium">
                        <Lock className="w-3 h-3" /> Verified · Sumsub
                      </span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm mb-3">
                      <div><p className="text-xs text-gray-400">Full Legal Name</p><p className="font-medium text-gray-700">{piiFullName || kycProfile?.fullLegalName || "—"}</p></div>
                      <div><p className="text-xs text-gray-400">Date of Birth</p><p className="font-medium text-gray-700">{piiDob || kycProfile?.dateOfBirth || "—"}</p></div>
                      <div><p className="text-xs text-gray-400">Nationality</p><p className="font-medium text-gray-700">{piiNationality || kycProfile?.nationality || "—"}</p></div>
                    </div>
                    <p className="text-xs text-gray-400 flex items-start gap-1">
                      <Lock className="w-3 h-3 flex-shrink-0 mt-0.5" />
                      Identity information is locked after verification and cannot be edited. Contact{" "}
                      <a href="mailto:compliance@amaxglobal.com.au" className="underline ml-0.5">compliance@amaxglobal.com.au</a>{" "}
                      to request a change.
                    </p>
                    <p className="text-xs text-blue-600 mt-1.5">
                      Identity verification is performed by our external provider (Sumsub). Verified data is locked to ensure compliance with AML/CTF obligations.
                    </p>
                  </div>
                ) : (
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                        <span className="text-blue-700 text-xs font-bold">A</span>
                      </div>
                      <h4 className="text-sm font-semibold text-gray-800">Your Identity</h4>
                      <span className="text-xs text-gray-400 ml-auto">Must match your ID exactly</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="pii-fullname" className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                          Full Legal Name <span className="text-red-500">*</span>
                        </Label>
                        <Input
                          id="pii-fullname"
                          placeholder="As shown on your passport or driver licence"
                          value={piiFullName}
                          onChange={e => setPiiFullName(e.target.value)}
                          className="h-10 text-sm"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="pii-dob" className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                          Date of Birth <span className="text-red-500">*</span>
                        </Label>
                        <Input
                          id="pii-dob"
                          type="date"
                          value={piiDob}
                          onChange={e => setPiiDob(e.target.value)}
                          className="h-10 text-sm"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="pii-nationality" className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                          Country of Nationality <span className="text-red-500">*</span>
                        </Label>
                        <Input
                          id="pii-nationality"
                          placeholder="e.g. Australia"
                          value={piiNationality}
                          onChange={e => setPiiNationality(e.target.value)}
                          className="h-10 text-sm"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="pii-phone" className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                          Mobile Number <span className="text-red-500">*</span>
                        </Label>
                        <Input
                          id="pii-phone"
                          type="tel"
                          placeholder="+61 400 000 000"
                          value={piiPhone}
                          onChange={e => setPiiPhone(e.target.value)}
                          className="h-10 text-sm"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* Phone field — shown here only when identity is locked (phone was in Section A before) */}
                {idVerifyComplete && (
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                        <span className="text-blue-700 text-xs font-bold">B</span>
                      </div>
                      <h4 className="text-sm font-semibold text-gray-800">Contact Details</h4>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="pii-phone-locked" className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                        Mobile Number <span className="text-red-500">*</span>
                      </Label>
                      <Input
                        id="pii-phone-locked"
                        type="tel"
                        placeholder="+61 400 000 000"
                        value={piiPhone}
                        onChange={e => setPiiPhone(e.target.value)}
                        className="h-10 text-sm"
                      />
                    </div>
                  </div>
                )}

                <div className="border-t border-gray-100" />

                {/* Section B/C — Residential Address */}
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                      <span className="text-blue-700 text-xs font-bold">B</span>
                    </div>
                    <h4 className="text-sm font-semibold text-gray-800">Residential Address</h4>
                    <span className="text-xs text-gray-400 ml-auto">No PO Box</span>
                  </div>
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="pii-addr" className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                        Street Address <span className="text-red-500">*</span>
                      </Label>
                      <Input id="pii-addr" placeholder="" value={piiAddress} onChange={e => setPiiAddress(e.target.value)} className="h-10 text-sm" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5 col-span-2 sm:col-span-1">
                        <Label htmlFor="pii-suburb" className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                          Suburb / City <span className="text-red-500">*</span>
                        </Label>
                        <Input id="pii-suburb" placeholder="" value={piiSuburb} onChange={e => setPiiSuburb(e.target.value)} className="h-10 text-sm" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                          State <span className="text-red-500">*</span>
                        </Label>
                        <Select value={piiStateRegion} onValueChange={setPiiStateRegion}>
                          <SelectTrigger className="h-10 text-sm"><SelectValue placeholder="State" /></SelectTrigger>
                          <SelectContent>
                            {["NSW","VIC","QLD","WA","SA","TAS","ACT","NT"].map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                            <SelectItem value="Other">Other</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="pii-postcode" className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                          Postcode <span className="text-red-500">*</span>
                        </Label>
                        <Input id="pii-postcode" placeholder="" maxLength={8} value={piiPostcode} onChange={e => setPiiPostcode(e.target.value)} className="h-10 text-sm" />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="pii-addrcountry" className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                          Country
                        </Label>
                        <Input id="pii-addrcountry" placeholder="Australia" value={piiAddrCountry} onChange={e => setPiiAddrCountry(e.target.value)} className="h-10 text-sm" />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="border-t border-gray-100" />

                {/* Section C — Account Profile */}
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                      <span className="text-blue-700 text-xs font-bold">C</span>
                    </div>
                    <h4 className="text-sm font-semibold text-gray-800">Account Profile</h4>
                    <span className="text-xs text-gray-400 ml-auto">AML/CTF Act 2006 §32</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                        Employment Status <span className="text-red-500">*</span>
                      </Label>
                      <Select value={piiEmployment} onValueChange={setPiiEmployment}>
                        <SelectTrigger className="h-10 text-sm"><SelectValue placeholder="Select status" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="employed">Employed (full-time / part-time)</SelectItem>
                          <SelectItem value="self_employed">Self-employed / Business owner</SelectItem>
                          <SelectItem value="retired">Retired</SelectItem>
                          <SelectItem value="student">Student</SelectItem>
                          <SelectItem value="unemployed">Unemployed / Seeking work</SelectItem>
                          <SelectItem value="other">Other</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="pii-occupation" className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                        Occupation / Job Title
                      </Label>
                      <Input id="pii-occupation" placeholder="e.g. Software Engineer" value={piiOccupation} onChange={e => setPiiOccupation(e.target.value)} className="h-10 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                        Purpose of Account <span className="text-red-500">*</span>
                      </Label>
                      <Select value={piiPurpose} onValueChange={setPiiPurpose}>
                        <SelectTrigger className="h-10 text-sm"><SelectValue placeholder="Select purpose" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="personal_transfers">Personal / Family remittances</SelectItem>
                          <SelectItem value="business_payments">Business payments</SelectItem>
                          <SelectItem value="investment">Investment / Portfolio management</SelectItem>
                          <SelectItem value="fx_conversion">FX conversion</SelectItem>
                          <SelectItem value="savings">Savings / Multi-Currency Account management</SelectItem>
                          <SelectItem value="crypto">Cryptocurrency exchange</SelectItem>
                          <SelectItem value="other">Other</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                        Source of Funds <span className="text-red-500">*</span>
                      </Label>
                      <Select value={piiSourceFunds} onValueChange={setPiiSourceFunds}>
                        <SelectTrigger className="h-10 text-sm"><SelectValue placeholder="Select source" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="employment">Employment / Salary</SelectItem>
                          <SelectItem value="business">Business income</SelectItem>
                          <SelectItem value="savings">Personal savings</SelectItem>
                          <SelectItem value="inheritance">Inheritance / Gift</SelectItem>
                          <SelectItem value="property">Property / Rental income</SelectItem>
                          <SelectItem value="investment">Investment returns</SelectItem>
                          <SelectItem value="crypto">Crypto / Digital assets</SelectItem>
                          <SelectItem value="other">Other</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label htmlFor="pii-taxcountry" className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                        Country of Tax Residency
                      </Label>
                      <Input id="pii-taxcountry" placeholder="e.g. Australia (for CRS / FATCA reporting)" value={piiTaxCountry} onChange={e => setPiiTaxCountry(e.target.value)} className="h-10 text-sm" />
                    </div>
                  </div>
                </div>

                {/* Footer actions */}
                <div className="pt-1 space-y-3">
                  <div className="flex gap-2">
                    {editStep1 && kycProfile?.kycProfileComplete && (
                      <Button
                        variant="outline"
                        className="h-11 text-sm rounded-xl"
                        onClick={() => setEditStep1(false)}
                      >
                        Cancel
                      </Button>
                    )}
                    <Button
                      className="flex-1 h-11 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-xl"
                      disabled={profileMutation.isPending}
                      onClick={handleProfileSubmit}
                    >
                      {profileMutation.isPending ? (
                        <span className="flex items-center gap-2"><RefreshCw className="w-4 h-4 animate-spin" /> Saving…</span>
                      ) : editStep1 ? (
                        "Save Changes"
                      ) : (
                        "Continue to Identity Verification →"
                      )}
                    </Button>
                  </div>
                  <div className="flex items-center justify-center gap-4 text-xs text-gray-400">
                    <span className="flex items-center gap-1"><Lock className="w-3 h-3" /> 256-bit encrypted</span>
                    <span>·</span>
                    <span>AUSTRAC registered</span>
                    <span>·</span>
                    <span>Privacy Act 1988</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Know Your Customer (KYC) Verification</CardTitle>
              <p className="text-sm text-gray-500">Upload documents directly on each step. Steps unlock automatically as you progress.</p>
            </CardHeader>
            <CardContent className="space-y-3">
              {kycStepDefs.map((def) => {
                const status    = stepStatuses[def.id];
                const fileName  = stepFiles[def.id];
                const Icon      = def.icon;
                const canUpload = def.uploadId && (status === "in_progress" || status === "under_review");

                // ── Step 3 expanded identity verification card ──────────────
                if (def.id === 3 && status === "in_progress") {
                  const docLabels = {
                    passport:       { label: "Passport",       sub: "Any country",        hint: "You will be guided to upload your passport securely within the verification session provided by our external KYC provider." },
                    driver_licence: { label: "Driver Licence", sub: "Australian only",    hint: "You will be guided to upload your driver licence (both sides) securely within the verification session provided by our external KYC provider." },
                    national_id:    { label: "National ID",    sub: "Foreign nationals",  hint: "You will be guided to upload your national identity card (both sides) securely within the verification session provided by our external KYC provider." },
                  };
                  const dl = docLabels[docType];
                  const needsBack = docType !== "passport";
                  const animSteps = [
                    { label: "Documents Received",       icon: FileText  },
                    { label: "Identity Matching",        icon: User      },
                    { label: "Sanctions & PEP Screening",icon: Shield    },
                    { label: "Risk Score Assigned",      icon: CheckCircle },
                  ];

                  return (
                    <div key={def.id} className="border-2 border-yellow-300 bg-yellow-50 rounded-xl overflow-hidden">
                      {/* Step header */}
                      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-yellow-500">
                          <User className="w-5 h-5 text-white" />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs text-gray-400 font-medium">Step {def.id} of 4</span>
                            <h3 className="font-semibold text-gray-900">Document upload &amp; ID verification</h3>
                            <Badge className="bg-yellow-100 text-yellow-800">In Progress</Badge>
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5">Upload your government-issued ID and a biometric selfie — required under AUSTRAC electronic verification standards</p>
                        </div>
                      </div>

                      {verifyMode === "idle" && (
                        <div className="px-4 pb-5 space-y-4">
                          {/* Document type selector */}
                          <div className="bg-white border rounded-xl p-4 space-y-3">
                            <h4 className="font-semibold text-sm">Select your document type</h4>
                            <p className="text-xs text-muted-foreground">Choose the government-issued ID you will upload</p>
                            <div className="grid grid-cols-3 gap-3">
                              {(["passport","driver_licence","national_id"] as const).map((dt) => {
                                const info = docLabels[dt];
                                return (
                                  <button
                                    key={dt}
                                    type="button"
                                    onClick={() => setDocType(dt)}
                                    className={`border-2 rounded-xl p-3 text-center transition-all ${
                                      docType === dt
                                        ? "border-blue-500 bg-blue-50"
                                        : "border-gray-200 bg-white hover:border-gray-300"
                                    }`}
                                  >
                                    <div className="text-2xl mb-1">
                                      {dt === "passport" ? "📕" : dt === "driver_licence" ? "🚗" : "🪪"}
                                    </div>
                                    <div className="text-xs font-semibold">{info.label}</div>
                                    <div className="text-xs text-muted-foreground">{info.sub}</div>
                                  </button>
                                );
                              })}
                            </div>
                            <div className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">{dl.hint}</div>
                          </div>

                          {/* Sumsub info panel */}
                          <div className="bg-white border rounded-xl p-4 space-y-3">
                            <div className="flex items-start gap-3">
                              <Shield className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0" />
                              <div>
                                <h4 className="font-semibold text-sm text-gray-900">Secure Identity Verification via Sumsub</h4>
                                <p className="text-xs text-muted-foreground mt-1">
                                  Clicking the button below launches a secure session with our external KYC provider. You will be guided through:
                                </p>
                                <ul className="text-xs text-gray-600 mt-1.5 space-y-0.5 pl-2">
                                  <li>• Uploading your government-issued ID (guided securely within the session)</li>
                                  <li>• Completing a live biometric selfie check</li>
                                  <li>• Automated verification checks — typically under 2 minutes</li>
                                </ul>
                                <p className="text-xs text-muted-foreground mt-2">
                                  Biometric and identity data are processed by our external verification provider and are not stored by AMAX GLOBAL Pty Ltd. Sumsub supports AML/CTF-compliant identity verification processes in accordance with Australian regulatory requirements.
                                </p>
                              </div>
                            </div>
                            <div className="grid grid-cols-3 gap-2 text-xs text-center">
                              {[
                                { icon: "📷", label: "Scan document" },
                                { icon: "🤳", label: "Live selfie" },
                                { icon: "✅", label: "Instant result" },
                              ].map(step => (
                                <div key={step.label} className="bg-blue-50 rounded-lg py-2">
                                  <div className="text-base mb-0.5">{step.icon}</div>
                                  <div className="text-gray-700 font-medium">{step.label}</div>
                                </div>
                              ))}
                            </div>
                          </div>

                          <Button
                            className="w-full h-11 bg-blue-600 hover:bg-blue-700 text-white font-semibold"
                            disabled={verifyMode === "loading"}
                            onClick={handleIdVerifySubmit}
                          >
                            {verifyMode === "loading" ? (
                              <span className="flex items-center gap-2"><RefreshCw className="w-4 h-4 animate-spin" /> Connecting to Sumsub…</span>
                            ) : (
                              <span className="flex items-center gap-2"><Camera className="w-4 h-4" /> Start Identity Verification with Sumsub →</span>
                            )}
                          </Button>
                          <p className="text-xs text-center text-muted-foreground flex items-center justify-center gap-1">
                            <Lock className="w-3 h-3" /> Encrypted · AML/CTF-compliant · Privacy Act 1988
                          </p>
                        </div>
                      )}

                      {/* Loading state */}
                      {verifyMode === "loading" && (
                        <div className="px-4 pb-5 flex flex-col items-center gap-3 py-6">
                          <RefreshCw className="w-8 h-8 text-blue-500 animate-spin" />
                          <p className="text-sm font-medium text-gray-700">Connecting to verification provider…</p>
                          <p className="text-xs text-muted-foreground">Please wait while we prepare your secure session.</p>
                        </div>
                      )}

                      {/* Sumsub WebSDK — embedded verification session */}
                      {verifyMode === "sumsub_sdk" && (
                        <div className="px-4 pb-5 space-y-3">
                          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                            <div className="flex items-start gap-3 mb-3">
                              <Shield className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0" />
                              <div>
                                <p className="font-semibold text-blue-900 text-sm">Secure Sumsub Verification Session Active</p>
                                <p className="text-xs text-blue-700 mt-0.5">
                                  Complete your identity verification in the widget below. Your documents and biometric data are processed by
                                  Sumsub, our external identity verification provider, in accordance with AML/CTF obligations. This typically takes 1–3 minutes.
                                </p>
                              </div>
                            </div>
                            <div className="text-xs text-blue-600 bg-blue-100 rounded-lg px-3 py-2 flex items-center gap-2">
                              <RefreshCw className="w-3 h-3 animate-spin flex-shrink-0" />
                              Awaiting verification result from Sumsub…
                            </div>
                          </div>
                          {/* Sumsub WebSDK mount point — SDK injects UI here */}
                          <div
                            id="sumsub-websdk-container"
                            className="rounded-xl overflow-hidden border border-gray-200 shadow-sm"
                            style={{ minHeight: "600px" }}
                          />
                          <p className="text-xs text-center text-muted-foreground flex items-center justify-center gap-1">
                            <Lock className="w-3 h-3" /> Biometric and identity data are processed by Sumsub and are not stored by AMAX GLOBAL Pty Ltd — in accordance with the Privacy Act 1988 and AML/CTF Act 2006.
                          </p>
                        </div>
                      )}

                      {/* Manual review pending — no Sumsub credentials configured */}
                      {verifyMode === "manual_review" && (
                        <div className="px-4 pb-5">
                          <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-5 space-y-3">
                            <div className="flex items-start gap-3">
                              <Clock className="w-6 h-6 text-yellow-600 flex-shrink-0 mt-0.5" />
                              <div>
                                <p className="font-semibold text-yellow-900">Documents Received — Awaiting Manual Review</p>
                                <p className="text-sm text-yellow-700 mt-1">
                                  Your identity documents have been received and queued for review by our external KYC provider, Sumsub. You will be notified at your registered email address
                                  within <strong>1–2 business days</strong>.
                                </p>
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2 text-xs">
                              <div className="bg-white border border-yellow-200 rounded-lg px-3 py-2">
                                <p className="text-gray-500">Review Status</p>
                                <p className="font-semibold text-yellow-700">In Queue</p>
                              </div>
                              <div className="bg-white border border-yellow-200 rounded-lg px-3 py-2">
                                <p className="text-gray-500">Expected Turnaround</p>
                                <p className="font-semibold text-yellow-700">1–2 business days</p>
                              </div>
                            </div>
                            <div className="flex justify-between items-center">
                              <p className="text-xs text-muted-foreground flex items-center gap-1">
                                <Lock className="w-3 h-3" /> Questions? Contact{" "}
                                <a href="mailto:info@amaxglobal.com.au" className="underline">info@amaxglobal.com.au</a>
                              </p>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs flex-shrink-0"
                                disabled={identityResetMutation.isPending}
                                onClick={() => identityResetMutation.mutate()}
                              >
                                <RefreshCw className={`w-3 h-3 mr-1.5 ${identityResetMutation.isPending ? "animate-spin" : ""}`} />
                                {identityResetMutation.isPending ? "Resetting…" : "Re-submit via Sumsub"}
                              </Button>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Verified — Sumsub approved */}
                      {verifyMode === "approved" && (
                        <div className="px-4 pb-5">
                          <div className="bg-green-50 border border-green-200 rounded-xl p-5 space-y-3">
                            <div className="flex items-center gap-3">
                              <CheckCircle className="w-8 h-8 text-green-600 flex-shrink-0" />
                              <div>
                                <p className="font-semibold text-green-900">Identity Verified</p>
                                <p className="text-sm text-green-700">All checks passed — document verified, face matched, sanctions clear</p>
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2 text-xs">
                              <div className="bg-white border border-green-200 rounded-lg px-3 py-2">
                                <p className="text-gray-500">Provider</p>
                                <p className="font-semibold text-green-700">Sumsub</p>
                              </div>
                              <div className="bg-white border border-green-200 rounded-lg px-3 py-2">
                                <p className="text-gray-500">Account Status</p>
                                <p className="font-semibold text-green-700">Unlocked</p>
                              </div>
                            </div>
                            <p className="text-xs text-center text-muted-foreground flex items-center justify-center gap-1">
                              <Lock className="w-3 h-3" /> 256-bit encrypted — processed under the AMAX Privacy Policy &amp; AML/CTF Act 2006
                            </p>
                          </div>
                        </div>
                      )}

                      {/* Declined */}
                      {verifyMode === "declined" && (
                        <div className="px-4 pb-5 space-y-3">
                          <div className="bg-red-50 border border-red-200 rounded-xl p-5 space-y-3">
                            <div className="flex items-center gap-3">
                              <AlertTriangle className="w-6 h-6 text-red-600 flex-shrink-0" />
                              <div>
                                <p className="font-semibold text-red-900">Verification Unsuccessful</p>
                                <p className="text-sm text-red-700">
                                  Your identity could not be verified automatically. Common reasons include:
                                </p>
                              </div>
                            </div>
                            <ul className="text-xs text-red-700 space-y-1 pl-2">
                              {[
                                "Document image was blurry or partially obscured — please retake in good lighting",
                                "Name on document does not match your registered account name",
                                "Document is expired or from a country not currently accepted",
                                "Selfie did not match the photo on your ID — ensure your face is clearly visible",
                              ].map(r => (
                                <li key={r} className="flex items-start gap-1.5">
                                  <span className="text-red-400 mt-0.5">•</span>{r}
                                </li>
                              ))}
                            </ul>
                            <p className="text-xs text-red-600">
                              If the problem persists, contact our compliance team at{" "}
                              <a href="mailto:info@amaxglobal.com.au" className="underline font-medium">info@amaxglobal.com.au</a>.
                            </p>
                            <Button className="w-full bg-gray-900 hover:bg-gray-800 text-white" onClick={() => { setVerifyMode("idle"); setDocExpiry(""); setDocIssueCountry(""); }}>
                              Try Again with Better Documents
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                }

                // ── Step 3 under_review — documents submitted, awaiting Sumsub result ──
                if (def.id === 3 && status === "under_review" && !editStep3) {
                  return (
                    <div key={def.id} className="border-2 border-amber-300 bg-amber-50 rounded-xl overflow-hidden">
                      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-amber-500">
                          <Clock className="w-5 h-5 text-white" />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs text-gray-400 font-medium">Step 3 of 4</span>
                            <h3 className="font-semibold text-gray-900">Identity Verification</h3>
                            <Badge className="bg-amber-100 text-amber-800">Under Review</Badge>
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5">Your documents have been submitted to Sumsub for review</p>
                        </div>
                      </div>
                      <div className="px-4 pb-5 space-y-3">
                        <div className="bg-white border border-amber-200 rounded-xl p-4 space-y-3">
                          {/* Status info grid */}
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                              <p className="text-gray-500">Review Status</p>
                              <p className="font-semibold text-amber-800">Pending Sumsub Review</p>
                            </div>
                            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                              <p className="text-gray-500">KYC Provider</p>
                              <p className="font-semibold text-amber-800">Sumsub (external)</p>
                            </div>
                            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                              <p className="text-gray-500">Expected Turnaround</p>
                              <p className="font-semibold text-amber-800">1–2 business days</p>
                            </div>
                            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                              <p className="text-gray-500">Document Type</p>
                              <p className="font-semibold text-amber-800 capitalize">{docType.replace(/_/g, " ")}</p>
                            </div>
                          </div>
                          {/* What was submitted */}
                          <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2.5 flex items-start gap-2 text-xs text-blue-800">
                            <FileCheck className="w-4 h-4 flex-shrink-0 mt-0.5 text-blue-600" />
                            <span>
                              Your identity documents and biometric selfie have been submitted to Sumsub for automated verification.
                              You will be notified at your registered email once a result is available.
                              If you need to update or re-submit your documents (e.g. due to image quality), use the button below.
                            </span>
                          </div>
                          {/* Re-submit option */}
                          <div className="pt-1 space-y-1.5">
                            <Button
                              variant="outline"
                              size="sm"
                              className="w-full h-9 text-xs border-amber-300 text-amber-800 hover:bg-amber-100"
                              disabled={identityResetMutation.isPending}
                              onClick={() => identityResetMutation.mutate()}
                            >
                              {identityResetMutation.isPending ? (
                                <span className="flex items-center gap-2"><RefreshCw className="w-3 h-3 animate-spin" /> Resetting…</span>
                              ) : (
                                <span className="flex items-center gap-2"><RefreshCw className="w-3 h-3" /> Re-submit via Sumsub</span>
                              )}
                            </Button>
                            <p className="text-xs text-center text-muted-foreground">
                              Re-submitting will cancel the current review and restart the Sumsub verification process.
                            </p>
                          </div>
                        </div>
                        <p className="text-xs text-center text-muted-foreground flex items-center justify-center gap-1">
                          <Lock className="w-3 h-3" /> Questions? Contact{" "}
                          <a href="mailto:info@amaxglobal.com.au" className="underline">info@amaxglobal.com.au</a>
                        </p>
                      </div>
                    </div>
                  );
                }

                // ── Step 2 expanded Customer Agreement card ─────────────────
                if (def.id === 2 && (status === "in_progress" || (status === "completed" && editStep2))) {
                  const agreementSections = [
                    {
                      title: "1. Overview",
                      content: `This Customer Agreement ("Agreement") governs your use of AMAX GLOBAL's services, including Multi-Currency Account, foreign exchange, remittance, and digital currency exchange ("Services"). AMAX GLOBAL Pty Ltd ("AMAX") is a registered remittance dealer and digital currency exchange provider regulated under the Anti-Money Laundering and Counter-Terrorism Financing Act 2006 (Cth) and enrolled with AUSTRAC.

By creating an account, you agree to this Agreement and any related policies. You must be at least 18 years old and legally capable of entering into binding contracts under Australian law. If you do not agree to this Agreement, you must not use our Services.

This Agreement sets out your rights and responsibilities, as well as AMAX GLOBAL's obligations under Australian law and international financial standards.`,
                    },
                    {
                      title: "2. Use of Services",
                      content: `You agree to:
• Use the Services only for lawful purposes
• Comply with all applicable Australian laws and regulations
• Provide accurate, current, and complete information at all times
• Use the Services solely on your own behalf unless you have disclosed in writing to AMAX that you are acting on behalf of another person or entity

AMAX may suspend, restrict, or terminate your account where required for fraud prevention, legal compliance, or risk management.

Prohibited Uses — You must not use the Services for:
• Money laundering, terrorism financing, or any activity in breach of Australian or international sanctions laws
• Transactions involving proceeds of crime or funds from illegitimate sources
• Structuring transactions to avoid AUSTRAC reporting thresholds
• Payments to or from sanctioned persons, entities, or jurisdictions
• Illegal gambling, fraud, or deceptive conduct
• The purchase or sale of illegal goods or services

This Agreement is governed by the laws of New South Wales and the Commonwealth of Australia.`,
                    },
                    {
                      title: "3. Privacy",
                      content: `AMAX GLOBAL collects and uses personal information in accordance with the Privacy Act 1988 (Cth) and the Australian Privacy Principles (APPs).

Purpose of Collection:
• Identity verification and KYC/AML compliance
• Risk management and fraud prevention
• Service delivery and improvement
• Regulatory reporting obligations

Information Sharing — We may share your personal information with:
• AUSTRAC, regulators, and law enforcement as required by law
• Third-party identity verification providers (e.g. Sumsub, Green ID)
• Financial institutions and service providers necessary to deliver our Services
• Professional advisors for compliance and legal purposes

We do not sell your personal information. You have the right to access and correct your personal information by contacting us at privacy@amaxglobal.com.au.

International Data Transfers: AMAX may transfer your personal data to service providers located outside Australia. We take reasonable steps to ensure overseas recipients handle your data consistently with the Australian Privacy Principles. By using our Services, you consent to such transfers.`,
                    },
                    {
                      title: "4. Compliance and AML/CTF",
                      content: `AMAX GLOBAL is a reporting entity under the Anti-Money Laundering and Counter-Terrorism Financing Act 2006 (Cth) enrolled with AUSTRAC. We provide designated services including remittance and digital currency exchange.

AMAX Obligations:
• Maintain an AML/CTF Program covering Part A (risk-based controls) and Part B (customer due diligence)
• Conduct risk-based customer identification and verification (KYC/CDD) prior to or as soon as practicable after commencing a business relationship
• Perform ongoing customer due diligence (OCDD) and enhanced customer due diligence (ECDD) where applicable
• Monitor transactions for suspicious activity using an automated transaction monitoring program
• Submit Suspicious Matter Reports (SMRs), Threshold Transaction Reports (TTRs) for AUD $10,000+ physical currency, and International Funds Transfer Instructions (IFTIs) to AUSTRAC
• Maintain records for a minimum of 7 years

Customer Obligations:
• Provide all requested identification documents and information accurately and promptly
• Respond to requests for enhanced due diligence within the timeframe specified by AMAX
• Update AMAX promptly on any changes to personal details, source of funds, beneficial ownership, PEP status, or sanctions status
• Not structure transactions or take other action designed to obstruct AMAX's AML/CTF obligations`,
                    },
                    {
                      title: "5. Sanctions Compliance",
                      content: `AMAX GLOBAL complies with Australian sanctions laws administered by the Department of Foreign Affairs and Trade (DFAT), UN Security Council sanctions as implemented in Australia, and other applicable international sanctions regimes.

You declare that:
• You are not listed on the DFAT Consolidated List, the UN Security Council Consolidated List, or any other applicable sanctions list
• You are not acting on behalf of a sanctioned person or entity
• Funds being transacted do not originate from or relate to sanctioned jurisdictions, persons, or entities

AMAX independently screens all accounts and transactions against applicable sanctions lists. We may freeze, block, or restrict accounts and transactions without prior notice where required by law. We will notify you to the extent permitted under applicable law.`,
                    },
                    {
                      title: "6. Digital Currency Risk Disclosure",
                      content: `Digital currency services involve significant risk. You should carefully consider whether digital currency exchange is appropriate for you in light of your financial circumstances and risk tolerance. AMAX does not provide financial advice in relation to digital currencies.

• Price Volatility — prices can change rapidly and materially. You may lose all or part of the value of your digital currency holdings at any time.
• Irreversibility — transactions on public blockchains are generally irreversible once confirmed. AMAX cannot reverse a confirmed blockchain transaction.
• Technology Risk — blockchain networks may experience congestion, forks, protocol changes, or outages.
• Liquidity Risk — limited market liquidity may prevent timely execution of transactions or result in prices significantly different from quoted prices.
• Regulatory Risk — changes in Australian or international laws may impact the value, legality, or availability of digital currencies.
• Custody Risk — digital asset transactions are executed via regulated third-party infrastructure; AMAX does not hold or custody digital assets on your behalf.

Important: Digital currencies are not legal tender in Australia, are not government-backed, and are not covered by the Financial Claims Scheme. AUD balances recorded in your AMAX Multi-Currency Account are also not protected by the Financial Claims Scheme, as AMAX is not an Authorised Deposit-taking Institution (ADI).`,
                    },
                    {
                      title: "7. Account Terms",
                      content: `Account Opening: Subject to satisfactory identity verification and risk assessment. AMAX reserves the right to decline any application at its discretion.

Transaction Limits: Default limits apply to all accounts. Enhanced limits may be available upon completion of additional KYC verification.

Fees and Charges: Fees are published on our website and within the AMAX platform. We will provide at least 14 days' notice before increasing fees, unless required urgently by law.

Changes to this Agreement: AMAX may update this Agreement at any time. For material changes, we will provide at least 30 days' notice. Your continued use of the Services constitutes acceptance of the updated terms.

Account Security: You are responsible for safeguarding your login credentials. Notify us immediately at support@amaxglobal.com.au if you believe your account has been compromised.

Dormant Accounts: An account is considered dormant after 12 consecutive months of inactivity. Dormant balances will be dealt with in accordance with the Unclaimed Money Act 1995 (NSW) and the Corporations Act 2001 (Cth).

Account Closure by AMAX: AMAX may close or suspend your account for legal, regulatory, risk, or compliance reasons, with 30 days' notice where possible.

Account Closure by You: You may close your account at any time by contacting support@amaxglobal.com.au. You must not close your account to evade a compliance investigation or pending transaction.

Currency Conversion: Exchange rates are confirmed at the time of transaction. AMAX applies a spread to the mid-market rate. Indicative rates are subject to change until a transaction is confirmed.

Complaints: Contact complaints@amaxglobal.com.au. We will acknowledge within 1 business day and aim to resolve within 30 days. Unresolved complaints may be escalated to AFCA (www.afca.org.au · 1800 931 678).

Record Keeping: Records retained for a minimum of 7 years as required under the AML/CTF Act.`,
                    },
                    {
                      title: "8. Erroneous and Unauthorised Transactions",
                      content: `Reporting Errors: If you believe a transaction is incorrect, duplicated, or unauthorised, you must notify AMAX as soon as possible and no later than 13 months from the transaction date at support@amaxglobal.com.au or via in-app support.

Investigation: AMAX will investigate and aim to provide a written response within 21 calendar days (or 45 days for complex matters). Where an error is confirmed and AMAX is at fault, AMAX will endeavour to correct the error by crediting your account or initiating a fund recall where feasible.

Misdirected Funds: If a payment is sent to an incorrect account because you provided incorrect payment details, AMAX will use reasonable efforts to assist recovery by contacting the receiving institution. Recovery is not guaranteed and may incur third-party costs. AMAX is not liable for losses arising from incorrect payment details provided by you.

Limitations: For remittance transactions, once funds have been paid out to the beneficiary, reversal may not be possible. For digital currency transactions, confirmed blockchain transactions cannot be reversed. Verify all transaction details carefully before confirming any payment.`,
                    },
                    {
                      title: "9. Liability",
                      content: `AMAX's Liability: To the extent permitted by law, AMAX's liability to you is limited to direct losses that are a reasonably foreseeable consequence of AMAX's breach of this Agreement or negligence. AMAX is not liable for indirect, consequential, special, punitive, or exemplary losses, including loss of profits or loss of data.

Exclusions — AMAX is not liable for losses arising from:
• Your failure to maintain the security of your account credentials
• You providing incorrect payment details or instructions
• Third-party service failures, including correspondent bank failures or blockchain network outages outside AMAX's control
• Delays or failures caused by circumstances beyond AMAX's reasonable control (see Force Majeure)
• Market fluctuations affecting the value of currencies or digital assets

Non-Excludable Rights: Nothing in this Agreement excludes or limits AMAX's liability for death or personal injury caused by its negligence, fraud or fraudulent misrepresentation, or any liability that cannot lawfully be limited under the Australian Consumer Law (Schedule 2 to the Competition and Consumer Act 2010 (Cth)).`,
                    },
                    {
                      title: "10. Force Majeure",
                      content: `AMAX will not be liable for any delay or failure to perform its obligations under this Agreement to the extent caused by circumstances beyond its reasonable control, including acts of God, natural disasters, pandemic, war, terrorism, government or regulatory action, power failure, internet or telecommunications outage, cyberattack, or failure of a third-party service provider.

In the event of a force majeure event, AMAX will notify you as soon as reasonably practicable and will use reasonable efforts to resume normal service as soon as possible. If the event continues for more than 30 days, either party may close the account in accordance with the account closure provisions of this Agreement.`,
                    },
                    {
                      title: "11. Platform Use and Intellectual Property",
                      content: `AMAX grants you a limited, non-exclusive, non-transferable, revocable licence to access and use the AMAX platform solely for the purpose of accessing the Services in accordance with this Agreement.

You must not:
• Copy, modify, reverse engineer, decompile, or create derivative works of the AMAX platform
• Use the platform for any unlawful purpose or in a manner that infringes the intellectual property rights of AMAX or any third party
• Use automated tools, bots, or scripts to access or interact with the platform without AMAX's prior written consent

All intellectual property rights in the AMAX platform, including software, trademarks, and content, remain the property of AMAX GLOBAL Pty Ltd or its licensors. This licence terminates automatically upon closure of your account.`,
                    },
                    {
                      title: "12. Identity and Use Declaration",
                      content: `• I am acting on my own behalf unless otherwise disclosed in writing to AMAX
• All information I provide is true, accurate, and complete
• I understand that AMAX will verify my identity and that my account activity may be monitored
• I will notify AMAX immediately of any change to the information I have provided`,
                    },
                    {
                      title: "13. Source of Funds Declaration",
                      content: `• All funds deposited, exchanged, or remitted through AMAX are derived from legitimate sources
• I will provide documentation to support the source of my funds if requested by AMAX
• I understand that failure to provide satisfactory source of funds documentation may result in AMAX declining or delaying a transaction or restricting my account`,
                    },
                    {
                      title: "14. Compliance Awareness Declaration",
                      content: `I understand that AMAX is required to:
• Verify my identity prior to or as soon as practicable after providing Services
• Monitor my transactions on an ongoing basis
• Conduct ongoing and enhanced customer due diligence (OCDD/ECDD)
• Submit SMRs, TTRs, and IFTIs to AUSTRAC when required

I will cooperate fully with AMAX's compliance requirements and will not take any action designed to obstruct or circumvent AMAX's AML/CTF obligations.`,
                    },
                    {
                      title: "15. Sanctions Declaration",
                      content: `• I am not subject to any applicable sanctions and am not acting on behalf of any sanctioned person or entity
• I will notify AMAX immediately if my sanctions status changes
• I understand that AMAX may freeze or restrict my account if I become subject to sanctions, without prior notice, as required by law`,
                    },
                    {
                      title: "16. Politically Exposed Person (PEP) Declaration",
                      content: `A Politically Exposed Person (PEP) is an individual who holds or has held a prominent public function, domestically or internationally, or who is an immediate family member or close associate of such a person.

• I am not a Politically Exposed Person (PEP), nor an immediate family member or close associate of a PEP
• If my PEP status changes, I will notify AMAX immediately
• I understand that PEP status may result in AMAX applying enhanced due diligence procedures to my account`,
                    },
                    {
                      title: "17. Ongoing Obligations Declaration",
                      content: `I will notify AMAX promptly of any material changes to my information, including:
• Residential address or contact details
• Source of funds or source of wealth
• Beneficial ownership of entities I operate through or on behalf of
• PEP or sanctions status
• Business activities, where I have provided business information in connection with this account`,
                    },
                    {
                      title: "18. Accuracy and Legal Compliance",
                      content: `• I confirm that all information provided in connection with this Agreement is accurate and complete
• I understand that providing false or misleading information is a criminal offence under Australian law, including the Criminal Code Act 1995 (Cth) and the AML/CTF Act
• I consent to AMAX maintaining records of my information and account activity, conducting ongoing verification checks, and monitoring my account for legal compliance purposes
• I consent to AMAX sharing my information with AUSTRAC and other regulatory or law enforcement authorities as required by law`,
                    },
                  ];

                  const sectionColors = [
                    "bg-blue-50 border-blue-200",
                    "bg-slate-50 border-slate-200",
                    "bg-purple-50 border-purple-200",
                    "bg-orange-50 border-orange-200",
                    "bg-red-50 border-red-200",
                    "bg-yellow-50 border-yellow-200",
                    "bg-green-50 border-green-200",
                    "bg-teal-50 border-teal-200",
                    "bg-sky-50 border-sky-200",
                    "bg-rose-50 border-rose-200",
                    "bg-violet-50 border-violet-200",
                    "bg-indigo-50 border-indigo-200",
                    "bg-cyan-50 border-cyan-200",
                    "bg-emerald-50 border-emerald-200",
                    "bg-pink-50 border-pink-200",
                    "bg-lime-50 border-lime-200",
                    "bg-amber-50 border-amber-200",
                    "bg-indigo-50 border-indigo-300",
                  ];

                  return (
                    <div key={def.id} className="border-2 border-indigo-300 bg-indigo-50 rounded-xl overflow-hidden">
                      {/* Header */}
                      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-indigo-600">
                          <FileCheck className="w-5 h-5 text-white" />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs text-gray-400 font-medium">Step 3 of 4</span>
                            <h3 className="font-semibold text-gray-900">Customer Agreement</h3>
                            <Badge className="bg-indigo-100 text-indigo-800">Action Required</Badge>
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5">
                            Read all 18 sections and sign below to proceed — Electronic Transactions Act 1999 (Cth)
                          </p>
                        </div>
                      </div>

                      <div className="px-4 pb-5 space-y-4">
                        {/* Section progress pills */}
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {agreementSections.map((sec, idx) => (
                            <span
                              key={idx}
                              className={`text-xs px-2 py-0.5 rounded-full border font-medium transition-all ${
                                sectionsRead.has(idx + 1)
                                  ? "bg-green-100 border-green-300 text-green-800"
                                  : "bg-gray-100 border-gray-300 text-gray-500"
                              }`}
                            >
                              {sectionsRead.has(idx + 1) ? "✓ " : ""}{idx + 1}. {sec.title.replace(/^\d+\. /, "").split(" ").slice(0, 2).join(" ")}
                            </span>
                          ))}
                        </div>

                        {agreementSigned && !editStep2 ? (
                          /* ── Already signed (only shown in non-edit completed view) ── */
                          <div className="bg-green-50 border border-green-200 rounded-xl p-5 space-y-3">
                            <div className="flex items-center gap-3">
                              <CheckCircle className="w-8 h-8 text-green-600 flex-shrink-0" />
                              <div>
                                <p className="font-semibold text-green-900">Customer Agreement Signed</p>
                                <p className="text-sm text-green-700">
                                  Agreement reference: <span className="font-mono font-semibold">{kycProfile?.agreementRef}</span>
                                </p>
                              </div>
                            </div>
                            {kycProfile?.agreementSignedAt && (
                              <p className="text-xs text-muted-foreground">
                                Signed on {new Date(kycProfile.agreementSignedAt).toLocaleString("en-AU", { timeZone: "Australia/Sydney" })} AEST
                                — v2.0 — Pursuant to Electronic Transactions Act 1999 (Cth)
                              </p>
                            )}
                          </div>
                        ) : (
                          <>
                            {/* ── Scrollable agreement document ── */}
                            <div
                              ref={agreementScrollRef}
                              onScroll={handleAgreementScroll}
                              className="bg-white border rounded-xl overflow-y-auto"
                              style={{ maxHeight: "420px" }}
                            >
                              {/* Identity strip */}
                              <div className="sticky top-0 z-10 bg-gray-900 text-white px-4 py-3 flex items-center gap-3">
                                <div className="w-8 h-8 rounded-full bg-indigo-500 flex items-center justify-center flex-shrink-0">
                                  <User className="w-4 h-4 text-white" />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-xs font-semibold truncate">{kycProfile?.fullLegalName ?? "Verified Customer"}</p>
                                  <p className="text-[10px] text-gray-400">Identity verified · AMAX GLOBAL Customer Agreement v2.0</p>
                                </div>
                                <div className="text-[10px] text-gray-400 flex-shrink-0">
                                  {new Date().toLocaleDateString("en-AU")}
                                </div>
                              </div>

                              {/* Agreement header */}
                              <div className="px-5 pt-4 pb-3 border-b">
                                <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wide">AMAX GLOBAL Pty Ltd — ABN 54 690 827 608</p>
                                <h3 className="text-base font-bold text-gray-900 mt-1">Customer Agreement</h3>
                                <p className="text-xs text-gray-500 mt-0.5">Version 2.0 · Effective April 2026 · Level 2, 8–12 King Street, Rockdale NSW 2216</p>
                              </div>

                              {/* 8 sections */}
                              {agreementSections.map((sec, idx) => (
                                <div
                                  key={idx}
                                  ref={el => { sectionRefs.current[idx] = el; }}
                                  className={`mx-4 my-3 rounded-lg border p-4 ${sectionColors[idx]}`}
                                >
                                  <div className="flex items-center gap-2 mb-2">
                                    <h4 className="text-sm font-bold text-gray-900">{sec.title}</h4>
                                    {sectionsRead.has(idx + 1) && (
                                      <CheckCircle className="w-3.5 h-3.5 text-green-600 flex-shrink-0" />
                                    )}
                                  </div>
                                  <p className="text-xs text-gray-700 leading-relaxed whitespace-pre-line">{sec.content}</p>
                                </div>
                              ))}

                              {/* Footer nudge */}
                              <div className="px-5 py-4 text-center text-xs text-gray-400">
                                {allSectionsRead
                                  ? "✓ All sections read — scroll down to sign"
                                  : "↓ Continue scrolling to read all sections before signing"}
                              </div>
                            </div>

                            {/* Signature section */}
                            <div className={`bg-white border-2 rounded-xl overflow-hidden transition-all ${
                              allSectionsRead ? "border-indigo-300" : "border-gray-200 opacity-60"
                            }`}>
                              {/* Sticky summary */}
                              <div className="bg-indigo-700 px-4 py-3">
                                <p className="text-xs text-indigo-100 leading-relaxed">
                                  By proceeding, you confirm that your information is accurate and complete, that you are not a sanctioned person or acting on behalf of one, and that you understand AMAX GLOBAL's monitoring and compliance obligations under Australian law.
                                </p>
                              </div>

                              <div className="p-4 space-y-3">
                              <div className="flex items-center gap-2">
                                <PenLine className="w-4 h-4 text-indigo-600 flex-shrink-0" />
                                <h4 className="text-sm font-semibold text-gray-900">Electronic Signature</h4>
                                {!allSectionsRead && (
                                  <span className="text-xs text-muted-foreground ml-auto">(unlock by reading all sections)</span>
                                )}
                              </div>
                              <p className="text-xs text-gray-600">
                                Type your full legal name exactly as registered (<span className="font-semibold">{kycProfile?.fullLegalName ?? "your name"}</span>)
                                to apply your electronic signature under the <em>Electronic Transactions Act 1999</em> (Cth).
                              </p>
                              <input
                                type="text"
                                disabled={!allSectionsRead}
                                placeholder={kycProfile?.fullLegalName ?? "Your full legal name"}
                                value={signatureName}
                                onChange={e => setSignatureName(e.target.value)}
                                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-serif italic disabled:bg-gray-100 disabled:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                              />
                              <div className={`rounded-lg border p-3 text-xs text-gray-600 leading-relaxed transition-all ${
                                allSectionsRead ? "bg-indigo-50 border-indigo-200" : "bg-gray-50 border-gray-200 opacity-50"
                              }`}>
                                By signing, I confirm I have read and agree to all 18 sections of this Agreement, including the declarations in Sections 12–18 regarding identity, source of funds, compliance awareness, sanctions status, ongoing obligations, and accuracy of information.
                              </div>
                              <div className="flex gap-2">
                                {editStep2 && status === "completed" && (
                                  <Button
                                    variant="outline"
                                    className="h-10 text-sm"
                                    onClick={() => setEditStep2(false)}
                                  >
                                    Cancel
                                  </Button>
                                )}
                                <Button
                                  className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white"
                                  disabled={!allSectionsRead || !signatureName.trim() || agreementMutation.isPending}
                                  onClick={() => agreementMutation.mutate({ signature: signatureName.trim(), pepDeclaration: false })}
                                >
                                  {agreementMutation.isPending ? "Recording signature…" : editStep2 ? "Re-sign Agreement" : "Sign Agreement & Continue"}
                                </Button>
                              </div>
                              <p className="text-[10px] text-center text-muted-foreground">
                                Electronic signature valid under the Electronic Transactions Act 1999 (Cth) · AMAX GLOBAL records your IP address and timestamp
                              </p>
                              </div>{/* /p-4 inner wrapper */}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  );
                }

                // ── Step 4 under_review — submitted to Sumsub / manual review ──
                if (def.id === 4 && status === "under_review") {
                  const isSumsubSubmitted = (stepFiles[4] === "sumsub-submitted") || (kycProfile?.addressDocFilename === "sumsub-submitted");
                  return (
                    <div key={def.id} className="border-2 border-amber-300 bg-amber-50 rounded-xl overflow-hidden">
                      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-amber-500">
                          <Clock className="w-5 h-5 text-white" />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs text-gray-400 font-medium">Step 4 of 4</span>
                            <h3 className="font-semibold text-gray-900">Proof of Address</h3>
                            <Badge className="bg-amber-100 text-amber-800">Under Review</Badge>
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {isSumsubSubmitted ? "Documents submitted to Sumsub — automated review in progress" : "Your address document is being reviewed by the compliance team"}
                          </p>
                        </div>
                      </div>
                      <div className="px-4 pb-5 space-y-3">
                        <div className="bg-white border border-amber-200 rounded-xl p-4 space-y-3">
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                              <p className="text-gray-500">Review Status</p>
                              <p className="font-semibold text-amber-800">{isSumsubSubmitted ? "Sumsub Automated Review" : "Pending Compliance Review"}</p>
                            </div>
                            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                              <p className="text-gray-500">{isSumsubSubmitted ? "Verification Provider" : "Expected Turnaround"}</p>
                              <p className="font-semibold text-amber-800">{isSumsubSubmitted ? "Sumsub (external)" : "1–2 business days"}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-3 bg-green-50 border border-green-200 rounded-lg px-3 py-2.5">
                            <FileCheck className="w-4 h-4 text-green-600 flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs text-gray-500">Submission Status</p>
                              <p className="text-sm font-medium text-gray-800">{isSumsubSubmitted ? "Documents submitted to Sumsub" : "Verification request submitted to Sumsub"}</p>
                            </div>
                          </div>
                          <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2.5 flex items-start gap-2 text-xs text-blue-800">
                            <Shield className="w-4 h-4 flex-shrink-0 mt-0.5 text-blue-600" />
                            <span>
                              {isSumsubSubmitted
                                ? "Your address document is under review with Sumsub. This page will update automatically when the result is available. You will also be notified at your registered email."
                                : "Your proof of address is with our compliance team. This step will move to Completed once approved. If there is an issue, you will be contacted at your registered email."
                              }
                            </span>
                          </div>
                        </div>
                        <div className="flex justify-between items-center">
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            <Lock className="w-3 h-3" /> Questions? Contact{" "}
                            <a href="mailto:info@amaxglobal.com.au" className="underline">info@amaxglobal.com.au</a>
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs flex-shrink-0"
                            onClick={() => addressResetMutation.mutate()}
                            disabled={addressResetMutation.isPending}
                          >
                            <RefreshCw className={`w-3 h-3 mr-1.5 ${addressResetMutation.isPending ? "animate-spin" : ""}`} />
                            {addressResetMutation.isPending ? "Resetting…" : "Re-submit via Sumsub"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                }

                // ── Step 4 completed — address verified ─────────────────────
                if (def.id === 4 && status === "completed") {
                  return (
                    <div key={def.id} className="border-2 border-green-200 bg-green-50 rounded-xl overflow-hidden">
                      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-green-600">
                          <CheckCircle className="w-5 h-5 text-white" />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs text-gray-400 font-medium">Step 4 of 4</span>
                            <h3 className="font-semibold text-gray-900">Proof of Address</h3>
                            <Badge className="bg-green-100 text-green-800">Verified</Badge>
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5">Address verified via Sumsub — AUSTRAC CDD requirement fulfilled</p>
                        </div>
                      </div>
                      <div className="px-4 pb-5">
                        <div className="bg-white border border-green-200 rounded-xl p-4 space-y-3">
                          <div className="flex items-center gap-3">
                            <CheckCircle className="w-7 h-7 text-green-600 flex-shrink-0" />
                            <div>
                              <p className="font-semibold text-green-900">Address Verified</p>
                              <p className="text-xs text-green-700">Document checked — address confirmed, date within 3 months, name matched</p>
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                              <p className="text-gray-500">Verification Provider</p>
                              <p className="font-semibold text-green-800">Sumsub (external)</p>
                            </div>
                            <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                              <p className="text-gray-500">Compliance Standard</p>
                              <p className="font-semibold text-green-800">AUSTRAC CDD</p>
                            </div>
                            <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                              <p className="text-gray-500">Accountable Party</p>
                              <p className="font-semibold text-green-800">AMAX GLOBAL Pty Ltd</p>
                            </div>
                            <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                              <p className="text-gray-500">Verification Result</p>
                              <p className="font-semibold text-green-800">Approved</p>
                            </div>
                          </div>
                          <div className="flex justify-between items-center pt-1 border-t border-green-100">
                            <p className="text-xs text-muted-foreground flex items-center gap-1">
                              <Lock className="w-3 h-3" /> Processed by Sumsub — not stored by AMAX · Privacy Act 1988
                            </p>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs flex-shrink-0"
                              onClick={() => addressResetMutation.mutate()}
                              disabled={addressResetMutation.isPending}
                            >
                              <RefreshCw className={`w-3 h-3 mr-1.5 ${addressResetMutation.isPending ? "animate-spin" : ""}`} />
                              {addressResetMutation.isPending ? "Resetting…" : "Re-verify via Sumsub"}
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                }

                // ── Step 4 expanded address verification card ───────────────
                if (def.id === 4 && status === "in_progress") {
                  return (
                    <div key={def.id} className="border-2 border-yellow-300 bg-yellow-50 rounded-xl overflow-hidden">
                      {/* Header */}
                      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-yellow-500">
                          <MapPin className="w-5 h-5 text-white" />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs text-gray-400 font-medium">Step 4 of 4</span>
                            <h3 className="font-semibold text-gray-900">Address Verification</h3>
                            <Badge className="bg-yellow-100 text-yellow-800">In Progress</Badge>
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5">Required under AUSTRAC CDD — your residential address must be verified by a third-party document</p>
                        </div>
                      </div>

                      <div className="px-4 pb-5 space-y-4">
                        {/* Why is this needed */}
                        <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 flex items-start gap-2 text-xs text-blue-800">
                          <Shield className="w-4 h-4 flex-shrink-0 mt-0.5 text-blue-600" />
                          <span>
                            <strong>AUSTRAC CDD requirement:</strong> Simply providing an address during registration is not sufficient. You must verify it with an independent document dated within the last 3 months.
                          </span>
                        </div>

                        {/* Accepted documents */}
                        <div className="bg-white border rounded-xl p-4 space-y-3">
                          <h4 className="font-semibold text-sm">Accepted proof of address documents</h4>
                          <div className="grid grid-cols-1 gap-2">
                            {[
                              { emoji: "💡", doc: "Utility bill", detail: "Electricity, gas, water, or internet — must show your name and address" },
                              { emoji: "🏦", doc: "Bank statement", detail: "From an Australian or internationally recognised bank" },
                              { emoji: "🏛️", doc: "Government letter", detail: "ATO, Centrelink, Medicare, or local council correspondence" },
                              { emoji: "📄", doc: "Lease agreement", detail: "Signed tenancy agreement showing current address" },
                            ].map(item => (
                              <div key={item.doc} className="flex items-start gap-2.5 text-xs text-gray-700">
                                <span className="text-base flex-shrink-0 mt-0.5">{item.emoji}</span>
                                <div>
                                  <span className="font-medium">{item.doc}</span>
                                  <span className="text-muted-foreground"> — {item.detail}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800 flex items-center gap-1.5">
                            <Clock className="w-3.5 h-3.5 flex-shrink-0" />
                            Document must be issued within the <strong>last 3 months</strong>. Older documents will not be accepted.
                          </div>
                        </div>

                        {/* Sumsub POA SDK launcher */}
                        <div className="bg-white border rounded-xl p-4 space-y-3">
                          {addrVerifyMode === "idle" && (
                            <>
                              <h4 className="font-semibold text-sm flex items-center gap-1.5"><Shield className="w-5 h-5 text-indigo-600 flex-shrink-0" /> Secure Address Verification via Sumsub</h4>
                              <p className="text-xs text-muted-foreground">
                                Clicking the button below launches a secure session with our external KYC provider. You will be guided through:
                              </p>
                              <ul className="text-xs text-gray-700 space-y-1.5 pl-1">
                                <li className="flex items-start gap-2">
                                  <span className="text-indigo-500 mt-0.5">•</span>
                                  <span>Uploading your proof of address document (utility bill, bank statement, or lease agreement — guided securely within the session)</span>
                                </li>
                                <li className="flex items-start gap-2">
                                  <span className="text-indigo-500 mt-0.5">•</span>
                                  <span>Automated document verification checks — typically completed within minutes</span>
                                </li>
                              </ul>
                              <p className="text-xs text-muted-foreground flex items-start gap-1">
                                <Lock className="w-3 h-3 flex-shrink-0 mt-0.5" />
                                <span>Address document data is processed by our external verification provider and is not stored by AMAX GLOBAL Pty Ltd. Sumsub supports AML/CTF-compliant address verification processes in accordance with Australian regulatory requirements.</span>
                              </p>
                              <Button
                                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white"
                                disabled={addressStartMutation.isPending}
                                onClick={() => {
                                  setAddrVerifyMode("loading");
                                  addressStartMutation.mutate();
                                }}
                              >
                                {addressStartMutation.isPending ? "Starting verification…" : "Start Address Verification with Sumsub"}
                              </Button>
                            </>
                          )}

                          {addrVerifyMode === "loading" && (
                            <div className="flex items-center justify-center gap-3 py-8">
                              <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                              <span className="text-sm text-muted-foreground">Loading Sumsub verification…</span>
                            </div>
                          )}

                          {/* Sumsub WebSDK mounts here */}
                          <div
                            id="sumsub-address-websdk-container"
                            className={addrVerifyMode === "sumsub_sdk" ? "min-h-[500px]" : "hidden"}
                          />
                        </div>

                        <p className="text-xs text-center text-muted-foreground flex items-center justify-center gap-1">
                          <Lock className="w-3 h-3" /> Documents processed by Sumsub — not stored by AMAX GLOBAL · Privacy Act 1988 · AML/CTF Act 2006
                        </p>
                      </div>
                    </div>
                  );
                }

                // ── Step 3 completed — viewable summary card ────────────────
                if (def.id === 3 && status === "completed") {
                  return (
                    <div key={def.id} className="border-2 border-green-200 bg-green-50 rounded-xl overflow-hidden">
                      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-green-600">
                          <CheckCircle className="w-5 h-5 text-white" />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs text-gray-400 font-medium">Step {def.id} of 4</span>
                            <h3 className="font-semibold text-gray-900">Document upload &amp; ID verification</h3>
                            <Badge className="bg-green-100 text-green-800">Completed</Badge>
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5">Identity verified via Sumsub, our external identity verification provider</p>
                        </div>
                      </div>
                      <div className="px-4 pb-5">
                        <div className="bg-white border border-green-200 rounded-xl p-4 space-y-3">
                          <div className="flex items-center gap-3">
                            <CheckCircle className="w-7 h-7 text-green-600 flex-shrink-0" />
                            <div>
                              <p className="font-semibold text-green-900">Identity Verified</p>
                              <p className="text-xs text-green-700">All checks passed — document verified, face matched, sanctions clear</p>
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                              <p className="text-gray-500">KYC Provider</p>
                              <p className="font-semibold text-green-800">Sumsub (external)</p>
                            </div>
                            <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                              <p className="text-gray-500">Account Status</p>
                              <p className="font-semibold text-green-800">Unlocked</p>
                            </div>
                            <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                              <p className="text-gray-500">Compliance Standard</p>
                              <p className="font-semibold text-green-800">AUSTRAC CDD</p>
                            </div>
                            <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                              <p className="text-gray-500">Verification Result</p>
                              <p className="font-semibold text-green-800">Approved</p>
                            </div>
                          </div>
                          <div className="pt-2 border-t border-green-100 space-y-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="w-full h-8 text-xs border-green-300 text-green-800 hover:bg-green-100"
                              onClick={() => identityResetMutation.mutate()}
                              disabled={identityResetMutation.isPending}
                            >
                              <RefreshCw className={`w-3 h-3 mr-1.5 ${identityResetMutation.isPending ? "animate-spin" : ""}`} />
                              {identityResetMutation.isPending ? "Resetting…" : "Re-submit via Sumsub"}
                            </Button>
                            <p className="text-xs text-center text-muted-foreground flex items-center justify-center gap-1">
                              <Lock className="w-3 h-3" /> Biometric data processed by Sumsub — not stored by AMAX · Privacy Act 1988
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                }

                // ── Step 2 completed — agreement review with re-sign option ────
                if (def.id === 2 && status === "completed" && !editStep2) {
                  return (
                    <div key={def.id} className="border-2 border-green-200 bg-green-50 rounded-xl overflow-hidden">
                      {/* Header */}
                      <div className="flex items-center gap-3 px-4 pt-4 pb-3 border-b border-green-100">
                        <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 bg-green-600">
                          <CheckCircle className="w-5 h-5 text-white" />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs text-gray-400 font-medium">Step 2 of 4</span>
                            <h3 className="font-semibold text-gray-900">Customer Agreement</h3>
                            <Badge className="bg-green-100 text-green-800 text-xs">Signed</Badge>
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5">Electronic signature · Electronic Transactions Act 1999 (Cth)</p>
                        </div>
                        <Button size="sm" variant="outline" className="flex-shrink-0 h-8 text-xs" onClick={() => setEditStep2(true)}>
                          <PenLine className="w-3 h-3 mr-1" /> Review & Re-sign
                        </Button>
                      </div>

                      <div className="px-4 pb-4">
                        <div className="bg-white border border-green-200 rounded-xl overflow-hidden">

                          {/* Signing record */}
                          <div className="p-4">
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Signing Record</p>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-sm">
                              <div><span className="text-xs text-gray-400">Ref</span><p className="font-medium font-mono text-xs">{kycProfile?.agreementRef || "—"}</p></div>
                              <div><span className="text-xs text-gray-400">Version</span><p className="font-medium">{kycProfile?.agreementVersion || "—"}</p></div>
                              <div><span className="text-xs text-gray-400">Signed By</span><p className="font-medium">{kycProfile?.agreementSignature || kycProfile?.fullLegalName || "—"}</p></div>
                              <div><span className="text-xs text-gray-400">Signed At (AEST)</span><p className="font-medium">{kycProfile?.agreementSignedAt ? new Date(kycProfile.agreementSignedAt).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" }) : "—"}</p></div>
                            </div>
                          </div>

                          <div className="border-t border-gray-100" />

                          {/* Agreement sections agreed to */}
                          <div className="p-4">
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Agreement Sections</p>
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                              {["Overview & Parties","Use of Services","Privacy & Data","AML/CTF Obligations","Fees & Charges","Liability","Dispute Resolution","Sanctions Compliance","Service Suspension","Governing Law","PEP & EDD","Risk Disclosure","Travel Rule","Electronic Signing","Records Retention","Amendments"].map((s, i) => (
                                <div key={i} className="flex items-center gap-1.5 text-xs text-gray-600">
                                  <CheckCircle className="w-3 h-3 text-green-500 flex-shrink-0" />
                                  {i + 1}. {s}
                                </div>
                              ))}
                            </div>
                          </div>

                          <div className="border-t border-gray-100" />

                          {/* Key declarations */}
                          <div className="p-4">
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Declarations Made</p>
                            <div className="space-y-2">
                              <div className="flex items-start gap-2 text-xs text-gray-700">
                                <CheckCircle className="w-3.5 h-3.5 text-green-500 flex-shrink-0 mt-0.5" />
                                <span>Not a Politically Exposed Person (PEP) — or declared as PEP and subject to ECDD</span>
                              </div>
                              <div className="flex items-start gap-2 text-xs text-gray-700">
                                <CheckCircle className="w-3.5 h-3.5 text-green-500 flex-shrink-0 mt-0.5" />
                                <span>Not subject to sanctions under UN Security Council Resolutions, OFAC, DFAT or any other sanctions regime</span>
                              </div>
                              <div className="flex items-start gap-2 text-xs text-gray-700">
                                <CheckCircle className="w-3.5 h-3.5 text-green-500 flex-shrink-0 mt-0.5" />
                                <span>Consented to AML/CTF identity verification, transaction monitoring, and reporting obligations</span>
                              </div>
                              <div className="flex items-start gap-2 text-xs text-gray-700">
                                <CheckCircle className="w-3.5 h-3.5 text-green-500 flex-shrink-0 mt-0.5" />
                                <span>Funds are from lawful sources and not proceeds of crime</span>
                              </div>
                              <div className="flex items-start gap-2 text-xs text-gray-700">
                                <CheckCircle className="w-3.5 h-3.5 text-green-500 flex-shrink-0 mt-0.5" />
                                <span>Acknowledged Travel Rule obligations for digital currency transfers</span>
                              </div>
                            </div>
                          </div>

                          <div className="border-t border-gray-100 px-4 py-2.5 bg-gray-50">
                            <p className="text-xs text-muted-foreground flex items-center gap-1">
                              <Lock className="w-3 h-3" /> Agreement record retained for 7 years · AML/CTF Act 2006 s.106 · Customer may re-sign at any time via "Review & Re-sign"
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                }

                // ── Step 4 completed — read-only POA review ─────────────────
                if (def.id === 4 && status === "completed") {
                  return (
                    <div key={def.id} className="border-2 border-green-200 bg-green-50 rounded-xl overflow-hidden">
                      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-green-600">
                          <CheckCircle className="w-5 h-5 text-white" />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs text-gray-400 font-medium">Step 4 of 4</span>
                            <h3 className="font-semibold text-gray-900">Proof of Address</h3>
                            <Badge className="bg-green-100 text-green-800">Approved</Badge>
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5">Address document reviewed and approved by the AMAX GLOBAL compliance team</p>
                        </div>
                      </div>
                      <div className="px-4 pb-5">
                        <div className="bg-white border border-green-200 rounded-xl p-4 space-y-3">
                          <div className="flex items-center gap-3">
                            <CheckCircle className="w-7 h-7 text-green-600 flex-shrink-0" />
                            <div>
                              <p className="font-semibold text-green-900">Address Verified</p>
                              <p className="text-xs text-green-700">Document reviewed and accepted — residential address confirmed</p>
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                              <p className="text-gray-500">Document Submitted</p>
                              <p className="font-semibold text-green-800 truncate">{kycProfile?.addressDocFilename || stepFiles[4] || "—"}</p>
                            </div>
                            <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                              <p className="text-gray-500">Review Status</p>
                              <p className="font-semibold text-green-800">Approved</p>
                            </div>
                          </div>
                          <p className="text-xs text-center text-muted-foreground flex items-center justify-center gap-1 pt-1">
                            <Lock className="w-3 h-3" /> Document retained under AML/CTF Act 2006 record-keeping obligations — not editable
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                }

                return (
                  <div
                    key={def.id}
                    className={`flex items-start gap-4 p-4 border rounded-xl transition-all ${
                      status === "completed"    ? "border-green-200  bg-green-50"  :
                      status === "under_review" ? "border-blue-200   bg-blue-50"   :
                      status === "in_progress"  ? "border-yellow-300 bg-yellow-50" :
                      "border-gray-200 bg-gray-50 opacity-60"
                    }`}
                  >
                    {/* Step icon */}
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
                      status === "completed"    ? "bg-green-600"  :
                      status === "under_review" ? "bg-blue-500"   :
                      status === "in_progress"  ? "bg-yellow-500" :
                      "bg-gray-300"
                    }`}>
                      <Icon className="w-5 h-5 text-white" />
                    </div>

                    {/* Text */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="text-xs text-gray-400 font-medium">Step {def.id}</span>
                        <h3 className="font-semibold text-gray-900">{def.title}</h3>
                        <Badge className={statusColor(status)}>
                          {status === "under_review" ? "Under Review" : statusLabel(status)}
                        </Badge>
                      </div>
                      <p className="text-sm text-gray-600">{def.title}</p>
                      {fileName && (
                        <p className="text-xs text-blue-600 mt-1 flex items-center gap-1">
                          <CheckCircle className="w-3 h-3" /> {fileName} — submitted for review
                        </p>
                      )}
                      {status === "under_review" && !fileName && (
                        <p className="text-xs text-blue-600 mt-1">Document under review</p>
                      )}
                    </div>

                    {/* Action button */}
                    <div className="flex-shrink-0 mt-1">
                      {status === "completed" ? (
                        <CheckCircle className="w-5 h-5 text-green-600" />
                      ) : status === "under_review" ? (
                        <div className="flex flex-col items-center gap-1">
                          <RefreshCw className="w-4 h-4 text-blue-500" />
                          {def.uploadId && (
                            <label htmlFor={`${def.uploadId}-replace`} className="cursor-pointer">
                              <Button size="sm" variant="ghost" className="h-6 text-xs px-2" asChild>
                                <span>Replace</span>
                              </Button>
                              <input
                                id={`${def.uploadId}-replace`}
                                type="file"
                                accept=".pdf,.jpg,.jpeg,.png,.heic"
                                className="hidden"
                                onChange={(e) => handleKycUpload(def.id, def.title, e)}
                              />
                            </label>
                          )}
                        </div>
                      ) : canUpload ? (
                        <label htmlFor={def.uploadId ?? undefined} className="cursor-pointer">
                          <Button size="sm" asChild>
                            <span><Upload className="w-3 h-3 mr-1" /> Upload</span>
                          </Button>
                          <input
                            id={def.uploadId ?? undefined}
                            type="file"
                            accept=".pdf,.jpg,.jpeg,.png,.heic"
                            className="hidden"
                            onChange={(e) => handleKycUpload(def.id, def.title, e)}
                          />
                        </label>
                      ) : (
                        <Clock className="w-4 h-4 text-gray-300" />
                      )}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {/* Dynamic next-step prompt */}
          {nextStep && (
            <Card className="border-2 border-blue-200 bg-blue-50">
              <CardContent className="p-4 flex items-start gap-3">
                <Shield className="w-5 h-5 mt-0.5 flex-shrink-0 text-blue-600" />
                <div className="flex-1">
                  <h4 className="font-semibold mb-1 text-blue-900">
                    Next: {nextStep.title}
                  </h4>
                  <p className="text-sm mb-3 text-blue-700">
                    {nextStep.id === 2 && "Read and sign the AMAX Customer Agreement — covers terms, privacy, AML/CTF, sanctions, and risk disclosure. Scroll through all sections then type your legal name to sign."}
                    {nextStep.id === 3 && "Complete identity verification using your government-issued ID. You will be guided through the process securely via Sumsub, our external verification provider. This typically takes 1–3 minutes."}
                    {nextStep.id === 4 && "Upload a utility bill, bank statement, or government letter dated within the last 3 months showing your full name and address."}
                  </p>
                  {nextStep.uploadId && (
                    <label htmlFor={`next-${nextStep.uploadId}`} className="cursor-pointer">
                      <Button size="sm" asChild>
                        <span><Upload className="w-3 h-3 mr-1" /> Upload {nextStep.title} Document</span>
                      </Button>
                      <input
                        id={`next-${nextStep.uploadId}`}
                        type="file"
                        accept=".pdf,.jpg,.jpeg,.png,.heic"
                        className="hidden"
                        onChange={(e) => handleKycUpload(nextStep.id, nextStep.title, e)}
                      />
                    </label>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* All steps submitted — under review */}
          {!nextStep && (
            <Card className="border-2 border-blue-200 bg-blue-50">
              <CardContent className="p-4 flex items-center gap-3">
                <RefreshCw className="w-6 h-6 text-blue-500 flex-shrink-0" />
                <div>
                  <h4 className="font-semibold text-blue-900">All Documents Submitted — Under Review</h4>
                  <p className="text-sm text-blue-700">Our compliance team is reviewing your documents. This typically takes 1–2 business days. You will be notified by email once your account is approved.</p>
                </div>
              </CardContent>
            </Card>
          )}


        </TabsContent>

        {/* ── Regulatory Tab ── */}
        <TabsContent value="regulatory">
          <Card>
            <CardHeader><CardTitle>Regulatory Compliance</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {[
                  { title: "AUSTRAC — Digital Currency Exchange (DCE)", badge: "Registered", cls: "bg-green-100 text-green-800", text: "AMAX GLOBAL Pty Ltd is registered on the AUSTRAC Digital Currency Exchange Register. ABN 54 690 827 608. Registration is mandatory under the AML/CTF Act 2006 — it is a criminal offence to operate a DCE without registration." },
                  { title: "AUSTRAC — Remittance Sector Register", badge: "Partner Facilitated", cls: "bg-blue-100 text-blue-800", text: "AMAX facilitates transfer instructions via external regulated remittance and banking partners. Fiat-to-fiat cross-border transfer instructions are executed through these external regulated partners in accordance with AML/CTF obligations." },
                  { title: "Non-Custodial Model", badge: "Active", cls: "bg-green-100 text-green-800", text: "AMAX GLOBAL Pty Ltd does not hold or store client funds or digital assets. Fiat balances are held with external regulated banking partners, and digital asset transactions are executed via Independent Reserve Pty Ltd, an external regulated exchange. AMAX operates as a non-custodial platform facilitating transaction instructions only." },
                  { title: "FATF Travel Rule Compliance", badge: "Effective 1 Jul 2026", cls: "bg-orange-100 text-orange-800", text: "AMAX complies with FATF Travel Rule obligations for digital asset transactions, including the collection and transmission of originator and beneficiary information where required under AML/CTF regulations. Additional due diligence and reporting obligations may apply to certain digital asset transactions, including transfers involving self-hosted wallets." },
                  { title: "AUSTRAC — Compliance Officer", badge: "Appointed", cls: "bg-green-100 text-green-800", text: "AMAX has appointed an AML/CTF Compliance Officer (Qin Xiong) responsible for oversight of AML/CTF obligations, reporting, internal controls, and staff training. The Compliance Officer oversees the ongoing AML/CTF program and ensures compliance with AUSTRAC reporting requirements." },
                  { title: "Australian Privacy Act 1988", badge: "Compliant", cls: "bg-green-100 text-green-800", text: "All personal information is collected, held, and used in accordance with the Australian Privacy Act 1988 and the Australian Privacy Principles (APPs). Customer data is retained for 7 years as required by the AML/CTF Act." },
                  { title: "AML/CTF Act 2006 (Australia)", badge: "Compliant", cls: "bg-green-100 text-green-800", text: "Full compliance with the Anti-Money Laundering and Counter-Terrorism Financing Act 2006 (as amended by the AML/CTF Amendment Act 2024). Includes CDD, EDD, ongoing monitoring, SMR/TTR/IFTI reporting, and compulsory record-keeping for 7 years." },
                  { title: "ASIC — Consumer Compliance / AFSL", badge: "In Progress", cls: "bg-yellow-100 text-yellow-800", text: "AMAX is assessing licensing requirements under the evolving Australian digital asset regulatory framework, including the Corporations Amendment (Digital Assets Framework) Bill 2025. Disputes: AFCA · www.afca.org.au · 1800 931 678." },
                ].map((reg, i) => (
                  <div key={i} className="p-4 border rounded-xl">
                    <div className="flex items-center gap-2 mb-2">
                      <Building className="w-4 h-4 text-primary" />
                      <h3 className="font-semibold text-sm">{reg.title}</h3>
                    </div>
                    <Badge className={`${reg.cls} mb-2`}>{reg.badge}</Badge>
                    <p className="text-sm text-gray-600">{reg.text}</p>
                  </div>
                ))}
              </div>
              <div className="p-4 bg-blue-50 rounded-xl">
                <h4 className="font-semibold text-blue-900 mb-2">Regulatory Reminders</h4>
                <ul className="text-sm text-blue-700 space-y-1">
                  <li>• All users must complete KYC/AML verification before transacting</li>
                  <li>• Transactions of AUD 10,000 or more may be subject to regulatory reporting and enhanced due diligence requirements</li>
                  <li>• Suspicious activity is reported to AUSTRAC as required by law</li>
                  <li>• Transaction records are retained for a minimum of 7 years</li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

      </Tabs>
    </div>
  );
}
