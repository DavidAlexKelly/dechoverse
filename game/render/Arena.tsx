import React from "react";
import { NEVER_RAYCAST } from "@/game/render/instancing";
import { ARENA_HALF_SIZE } from "@/game/world/level";

const WALL_HEIGHT = 8;

/**
 * Floor, grid and the four boundary walls. Personal rooms pass a smaller
 * halfSize than the main arena.
 */
export function Arena({ halfSize = ARENA_HALF_SIZE }: { halfSize?: number }): React.ReactElement {
  const SIZE = halfSize * 2;
  const walls: Array<{
    position: [number, number, number];
    args: [number, number, number];
  }> = [
    {
      position: [0, WALL_HEIGHT / 2, -halfSize],
      args: [SIZE, WALL_HEIGHT, 1],
    },
    {
      position: [0, WALL_HEIGHT / 2, halfSize],
      args: [SIZE, WALL_HEIGHT, 1],
    },
    {
      position: [-halfSize, WALL_HEIGHT / 2, 0],
      args: [1, WALL_HEIGHT, SIZE],
    },
    {
      position: [halfSize, WALL_HEIGHT / 2, 0],
      args: [1, WALL_HEIGHT, SIZE],
    },
  ];

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} userData={{ shootable: true }}>
        <planeGeometry args={[SIZE, SIZE]} />
        <meshStandardMaterial color="#14121c" />
      </mesh>
      <gridHelper
        args={[SIZE, Math.round(SIZE / 1.5), "#a100ff", "#2c2740"]}
        position={[0, 0.01, 0]}
        raycast={NEVER_RAYCAST}
      />
      {walls.map((wall, index) => (
        <mesh key={index} position={wall.position} userData={{ shootable: true }}>
          <boxGeometry args={wall.args} />
          <meshStandardMaterial color="#241f36" emissive="#a100ff" emissiveIntensity={0.08} />
        </mesh>
      ))}
    </group>
  );
}
