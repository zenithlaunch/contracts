import { useRef } from "react";
import { motion, useInView } from "framer-motion";

interface ScrollRevealProps {
  children: React.ReactNode;
  className?: string;
  /** Delay in seconds */
  delay?: number;
  /** Animation direction */
  direction?: "up" | "left" | "right";
  /** Distance in pixels */
  distance?: number;
  /** Once visible, stay visible */
  once?: boolean;
}

export default function ScrollReveal({
  children,
  className,
  delay = 0,
  direction = "up",
  distance = 70,
  once = true,
}: ScrollRevealProps) {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once, margin: "-80px 0px" });

  const initial = {
    opacity: 0,
    y: direction === "up" ? distance : 0,
    x: direction === "left" ? -distance : direction === "right" ? distance : 0,
  };

  return (
    <motion.div
      ref={ref}
      className={className}
      initial={initial}
      animate={isInView ? { opacity: 1, y: 0, x: 0 } : initial}
      transition={{
        duration: 0.8,
        delay,
        ease: [0.22, 0.03, 0.26, 1],
      }}
    >
      {children}
    </motion.div>
  );
}

/** Stagger children — wrap each child in a ScrollReveal with increasing delay */
export function ScrollRevealStagger({
  children,
  className,
  baseDelay = 0,
  stagger = 0.1,
  direction = "up",
  distance = 50,
}: {
  children: React.ReactNode[];
  className?: string;
  baseDelay?: number;
  stagger?: number;
  direction?: "up" | "left" | "right";
  distance?: number;
}) {
  return (
    <div className={className}>
      {children.map((child, i) => (
        <ScrollReveal
          key={i}
          delay={baseDelay + i * stagger}
          direction={direction}
          distance={distance}
        >
          {child}
        </ScrollReveal>
      ))}
    </div>
  );
}
