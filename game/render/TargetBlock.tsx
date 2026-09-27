import React, { useRef, useState } from "react";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { NEVER_RAYCAST } from "@/game/render/instancing";
import css from "@/game/render/labels.module.css";
import type { TargetSpec } from "@/game/world/level";

interface TargetBlockProps {
  target: TargetSpec;
  /** Renders the block in a "hit" state right before the level transition. */
  hit: boolean;
  /**
   * How close the player has to be for this block to carry its label, or
   * Infinity to always label it.
   *
   * Every label is a real DOM element whose screen position drei recomputes
   * each frame, so a folder with two hundred children was paying two hundred
   * layout writes a frame for text that is a couple of pixels tall at the far
   * side of the arena. Labelling only what is nearby costs one distance check
   * per block instead.
   */
  labelRadius?: number;
}

/** How often a block reconsiders whether it is close enough to be labelled. */
const LABEL_CHECK_MS = 200;
/** Widening applied before a label is taken away again, so edges do not flicker. */
const LABEL_HYSTERESIS = 1.2;

/**
 * A single vertical rectangle representing a space, project, folder or
 * resource. Blocks you can enter are taller and carry a floating cap.
 */
export function TargetBlock({
  target,
  hit,
  labelRadius = Infinity,
}: TargetBlockProps): React.ReactElement {
  const { height } = target;
  const always = labelRadius === Infinity;
  const [labelled, setLabelled] = useState(always);
  const checkedAt = useRef(0);

  useFrame(({ camera }) => {
    if (always) {
      return;
    }
    const now = performance.now();
    if (now - checkedAt.current < LABEL_CHECK_MS) {
      return;
    }
    checkedAt.current = now;

    const dx = camera.position.x - target.position[0];
    const dz = camera.position.z - target.position[2];
    const distance = Math.hypot(dx, dz);
    const limit = labelled ? labelRadius * LABEL_HYSTERESIS : labelRadius;
    const next = distance < limit;
    if (next !== labelled) {
      setLabelled(next);
    }
  });

  return (
    <group position={target.position}>
      <mesh position={[0, height / 2, 0]} userData={{ shootable: true, targetId: target.id }}>
        <boxGeometry args={[1.2, height, 0.4]} />
        <meshStandardMaterial
          color={hit ? "#ffffff" : target.color}
          emissive={target.color}
          emissiveIntensity={hit ? 1.6 : 0.35}
        />
      </mesh>

      {target.kind === "enter" && (
        <mesh
          position={[0, height + 0.45, 0]}
          rotation={[0, Math.PI / 4, 0]}
          raycast={NEVER_RAYCAST}
        >
          <octahedronGeometry args={[0.32]} />
          <meshBasicMaterial color={target.color} />
        </mesh>
      )}

      {target.kind === "app" && (
        <mesh
          position={[0, height + 0.45, 0]}
          rotation={[Math.PI / 2, 0, 0]}
          raycast={NEVER_RAYCAST}
        >
          <torusGeometry args={[0.3, 0.08, 8, 24]} />
          <meshBasicMaterial color={target.color} />
        </mesh>
      )}

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} raycast={NEVER_RAYCAST}>
        <circleGeometry args={[1.1, 24]} />
        <meshBasicMaterial color={target.color} transparent opacity={0.16} />
      </mesh>

      {labelled && (
        <Html position={[0, height + 1.1, 0]} center distanceFactor={16} zIndexRange={[5, 0]}>
          <div className={css.blockLabel}>
            <div>{target.label}</div>
            {target.caption != null && <div className={css.blockCaption}>{target.caption}</div>}
          </div>
        </Html>
      )}
    </group>
  );
}
