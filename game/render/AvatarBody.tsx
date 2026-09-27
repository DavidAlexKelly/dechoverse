import React from "react";
import type { Appearance } from "@/game/domain/types";
import { Hat } from "@/game/render/Hat";

/**
 * What a player looks like: a coloured capsule with a nose, googly eyes, a hat
 * if they are wearing one, and a puddle of shadow under them.
 *
 * Shared by the world and by the character screen, which is the point — a
 * preview that was its own arrangement of meshes would drift from the thing it
 * is previewing.
 *
 * Two names matter to callers that animate this: the "body" group, which is
 * bobbed as the player walks, and the "pupilLeft" / "pupilRight" meshes, whose
 * positions are driven by a spring. Both are looked up with getObjectByName on
 * the group this is rendered into, so they must keep their names.
 */

/** Googly eyes: whites are fixed to the face, pupils swing on a spring. */
export const EYE_X = 0.13;
export const EYE_Y = 1.52;
export const EYE_Z = -0.325;
export const EYE_RADIUS = 0.1;
export const PUPIL_RADIUS = 0.045;

export function AvatarBody({ appearance }: { appearance: Appearance }): React.ReactElement {
  const { color, hat, hatColor } = appearance;

  return (
    <>
      <group name="body">
        <mesh position={[0, 0.95, 0]}>
          <capsuleGeometry args={[0.34, 1.1, 6, 12]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.25} />
        </mesh>

        {/* Nose cone showing which way they are looking. */}
        <mesh position={[0, 1.35, -0.42]} rotation={[-Math.PI / 2, 0, 0]}>
          <coneGeometry args={[0.13, 0.36, 10]} />
          <meshBasicMaterial color="#ffffff" />
        </mesh>

        {/* Whites sit on the face; the pupils are moved every frame by the
            spring in Avatars, so they swing when the avatar starts, stops or
            turns. */}
        {[-EYE_X, EYE_X].map((offset) => (
          <mesh
            key={`white-${offset}`}
            position={[offset, EYE_Y, EYE_Z]}
            rotation={[0, Math.PI, 0]}
          >
            <circleGeometry args={[EYE_RADIUS, 20]} />
            <meshBasicMaterial color="#ffffff" />
          </mesh>
        ))}
        <mesh name="pupilLeft" position={[-EYE_X, EYE_Y, EYE_Z - 0.006]} rotation={[0, Math.PI, 0]}>
          <circleGeometry args={[PUPIL_RADIUS, 16]} />
          <meshBasicMaterial color="#0a0812" />
        </mesh>
        <mesh name="pupilRight" position={[EYE_X, EYE_Y, EYE_Z - 0.006]} rotation={[0, Math.PI, 0]}>
          <circleGeometry args={[PUPIL_RADIUS, 16]} />
          <meshBasicMaterial color="#0a0812" />
        </mesh>

        {/* Inside the body group, so a hat bobs with the head it is on. */}
        {hat != null && <Hat path={hat} color={hatColor} />}
      </group>

      {/* Shadow puddle so they read as standing on the floor. Outside the body
          group on purpose: it stays welded to the ground while the body bobs. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <circleGeometry args={[0.45, 20]} />
        <meshBasicMaterial color={color} transparent opacity={0.2} />
      </mesh>
    </>
  );
}
