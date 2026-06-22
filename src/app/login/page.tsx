"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { BrandLogo } from "@/components/layout/brand-logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LogIn, Mail } from "lucide-react";

function LoginContent() {
  const searchParams = useSearchParams();
  const error = searchParams.get("error");

  const handleLogin = () => {
    window.location.href = "/api/auth/google/login";
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-8">
        <div className="flex flex-col items-center justify-center gap-4 text-center">
          <BrandLogo className="h-20 w-32" />
          <h1 className="font-mono text-4xl font-black tracking-normal">
            disp<span className="text-terminal-red">8</span>ch
          </h1>
          <p className="text-muted-foreground text-sm font-mono uppercase tracking-wider">
            Sign in to your personal AI assistant
          </p>
        </div>

        <Card>
          <CardHeader className="space-y-1">
            <CardTitle className="text-2xl text-center">Login</CardTitle>
            <CardDescription className="text-center">
              Choose your preferred login method
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {error && (
              <div className="border border-terminal-red bg-terminal-red/10 p-3 text-sm text-terminal-red text-center">
                Authentication failed: {error}
              </div>
            )}
            <Button
              className="w-full h-11"
              onClick={handleLogin}
              variant="outline"
            >
              <LogIn className="mr-2 h-4 w-4" />
              Continue with Google
            </Button>
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-card px-2 text-muted-foreground">
                  Or continue with
                </span>
              </div>
            </div>
            <Button variant="ghost" className="w-full" disabled>
              <Mail className="mr-2 h-4 w-4" />
              Email coming soon
            </Button>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground font-mono">
          By continuing, you agree to disp8ch&apos;s terms and privacy policy.
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-muted-foreground text-xs font-mono uppercase tracking-widest">Loading...</div>
      </div>
    }>
      <LoginContent />
    </Suspense>
  );
}
