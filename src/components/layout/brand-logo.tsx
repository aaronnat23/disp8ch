import Image from "next/image";
import { cn } from "@/lib/utils";

interface BrandLogoProps {
  className?: string;
  priority?: boolean;
}

export function BrandLogo({ className, priority = false }: BrandLogoProps) {
  return (
    <Image
      src="/logo.png"
      alt="disp8ch logo"
      width={1254}
      height={1254}
      priority={priority}
      className={cn("object-contain", className)}
    />
  );
}
