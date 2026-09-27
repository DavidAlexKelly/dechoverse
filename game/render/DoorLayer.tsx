import React from "react";
import { Html } from "@react-three/drei";
import { DOOR_TARGET_PREFIX, type PlacedDoor } from "@/game/domain/types";
import { NEVER_RAYCAST } from "@/game/render/instancing";
import css from "@/game/render/labels.module.css";

const DOOR_COLOR = "#ff8f4d";
const DOOR_HEIGHT = 3.6;

/**
 * Doors into personal rooms. Shaped like the space blocks so it reads as
 * "somewhere you can go", and shootable with the select tool.
 */
export function DoorLayer({
  doors,
  hitTargetId,
}: {
  doors: PlacedDoor[];
  hitTargetId: string | null;
}): React.ReactElement {
  return (
    <group>
      {doors.map((door) => {
        const targetId = `${DOOR_TARGET_PREFIX}${door.id}`;
        const hit = hitTargetId === targetId;
        return (
          <group key={door.id} position={door.position} rotation={[0, door.yaw, 0]}>
            <mesh position={[0, DOOR_HEIGHT / 2, 0]} userData={{ shootable: true, targetId }}>
              <boxGeometry args={[1.3, DOOR_HEIGHT, 0.4]} />
              <meshStandardMaterial
                color={hit ? "#ffffff" : DOOR_COLOR}
                emissive={DOOR_COLOR}
                emissiveIntensity={hit ? 1.6 : 0.4}
              />
            </mesh>

            {/* Frame, so a door reads as a doorway rather than a slab. */}
            <mesh position={[0, DOOR_HEIGHT / 2, -0.24]} userData={{ shootable: true, targetId }}>
              <boxGeometry args={[1.6, DOOR_HEIGHT + 0.3, 0.12]} />
              <meshStandardMaterial color="#3a2a1c" />
            </mesh>

            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} raycast={NEVER_RAYCAST}>
              <circleGeometry args={[1.1, 24]} />
              <meshBasicMaterial color={DOOR_COLOR} transparent opacity={0.18} />
            </mesh>

            <Html position={[0, DOOR_HEIGHT + 0.9, 0]} center distanceFactor={16}>
              <div className={css.blockLabel}>
                <div>{`${door.userId}'s Space`}</div>
                <div className={css.blockCaption}>Shoot to enter</div>
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}
