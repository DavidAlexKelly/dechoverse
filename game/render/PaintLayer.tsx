import React, { useLayoutEffect, useRef } from "react";
import type * as THREE from "three";
import type { PaintBlob } from "@/game/domain/types";
import { NEVER_RAYCAST, capacityFor, scratch } from "@/game/render/instancing";
import { DISC_GEOMETRY, DISC_MATERIAL } from "@/game/render/paintDisc";

/**
 * Legacy per-dab paint, from before strokes existed, drawn as one instanced
 * mesh.
 *
 * Not shootable, so bullets, paint and the eraser all pass straight through to
 * the surface underneath. Nothing writes these any more, but rooms hold
 * hundreds of them and a mesh each was hundreds of draw calls.
 */
export function PaintLayer({ blobs }: { blobs: PaintBlob[] }): React.ReactElement {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const capacity = capacityFor(blobs.length);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (mesh == null) {
      return;
    }

    const { matrix, position, quaternion, scale, color } = scratch;
    const count = Math.min(blobs.length, capacity);
    for (let index = 0; index < count; index++) {
      const blob = blobs[index];
      position.set(blob.position[0], blob.position[1], blob.position[2]);
      quaternion.set(
        blob.quaternion[0],
        blob.quaternion[1],
        blob.quaternion[2],
        blob.quaternion[3],
      );
      scale.setScalar(blob.radius);
      mesh.setMatrixAt(index, matrix.compose(position, quaternion, scale));
      mesh.setColorAt(index, color.set(blob.color));
    }

    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor != null) {
      mesh.instanceColor.needsUpdate = true;
    }
    mesh.computeBoundingSphere();
  }, [blobs, capacity]);

  return (
    <instancedMesh
      key={capacity}
      ref={meshRef}
      args={[DISC_GEOMETRY, DISC_MATERIAL, capacity]}
      raycast={NEVER_RAYCAST}
    />
  );
}
