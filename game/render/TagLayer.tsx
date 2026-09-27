import React from "react";
import type { TagDecal } from "@/game/domain/types";
import { NEVER_RAYCAST } from "@/game/render/instancing";

/**
 * Image tags stuck to walls, floors and blocks.
 *
 * One mesh each, because each carries its own texture — but not shootable, so
 * the ray never has to test them.
 */
export function TagLayer({ tags }: { tags: TagDecal[] }): React.ReactElement {
  return (
    <group>
      {tags.map((tag) => (
        <mesh
          key={tag.id}
          position={tag.position}
          quaternion={tag.quaternion}
          raycast={NEVER_RAYCAST}
        >
          <planeGeometry args={[tag.width, tag.height]} />
          <meshBasicMaterial map={tag.texture} transparent depthWrite={false} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}
