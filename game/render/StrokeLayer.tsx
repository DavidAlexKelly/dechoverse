import React, { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { MAX_STROKE_DABS } from "@/game/domain/codec";
import type { PaintStroke } from "@/game/domain/types";
import { NEVER_RAYCAST, capacityFor, scratch } from "@/game/render/instancing";
import { DISC_GEOMETRY, DISC_MATERIAL } from "@/game/render/paintDisc";

/** Its own material, because the colour of the stroke in hand can change. */
const WET_MATERIAL = new THREE.MeshBasicMaterial({
  transparent: true,
  opacity: 0.85,
  depthWrite: false,
});

/**
 * The stroke being sprayed right now.
 *
 * Kept separate from the committed ones because it changes several times a
 * second and is allocated at full size up front: growing the buffer instead
 * would remount the mesh on every tick.
 */
function WetStroke({ stroke }: { stroke: PaintStroke }): React.ReactElement {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (mesh == null) {
      return;
    }

    const { matrix, position, quaternion, scale } = scratch;
    WET_MATERIAL.color.set(stroke.color);
    const count = Math.min(stroke.dabs.length, MAX_STROKE_DABS);
    for (let index = 0; index < count; index++) {
      const dab = stroke.dabs[index];
      position.set(dab.position[0], dab.position[1], dab.position[2]);
      quaternion.set(dab.quaternion[0], dab.quaternion[1], dab.quaternion[2], dab.quaternion[3]);
      scale.setScalar(dab.radius);
      mesh.setMatrixAt(index, matrix.compose(position, quaternion, scale));
    }

    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [stroke]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[DISC_GEOMETRY, WET_MATERIAL, MAX_STROKE_DABS]}
      raycast={NEVER_RAYCAST}
    />
  );
}

/**
 * Every committed spray stroke in the room, drawn as one instanced mesh.
 *
 * A stroke used to be a mesh of its own, which was already far better than a
 * mesh per dab — but a well painted room is hundreds of strokes, and they
 * differ only in colour. That fits in the instance buffer, so the whole room's
 * paint is one draw call.
 *
 * Not shootable, so bullets, paint and the eraser all pass through to the
 * surface underneath.
 */
export function StrokeLayer({
  strokes,
  wet,
}: {
  strokes: PaintStroke[];
  /** The stroke currently being sprayed, not yet committed to the stream. */
  wet?: PaintStroke | null;
}): React.ReactElement {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const total = useMemo(
    () => strokes.reduce((sum, stroke) => sum + stroke.dabs.length, 0),
    [strokes],
  );
  const capacity = capacityFor(total);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (mesh == null) {
      return;
    }

    const { matrix, position, quaternion, scale, color } = scratch;
    let count = 0;
    for (const stroke of strokes) {
      color.set(stroke.color);
      for (const dab of stroke.dabs) {
        if (count >= capacity) {
          break;
        }
        position.set(dab.position[0], dab.position[1], dab.position[2]);
        quaternion.set(dab.quaternion[0], dab.quaternion[1], dab.quaternion[2], dab.quaternion[3]);
        scale.setScalar(dab.radius);
        mesh.setMatrixAt(count, matrix.compose(position, quaternion, scale));
        mesh.setColorAt(count, color);
        count++;
      }
      if (count >= capacity) {
        break;
      }
    }

    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor != null) {
      mesh.instanceColor.needsUpdate = true;
    }
    mesh.computeBoundingSphere();
  }, [strokes, capacity]);

  return (
    <group>
      <instancedMesh
        key={capacity}
        ref={meshRef}
        args={[DISC_GEOMETRY, DISC_MATERIAL, capacity]}
        raycast={NEVER_RAYCAST}
      />
      {wet != null && wet.dabs.length > 0 && <WetStroke stroke={wet} />}
    </group>
  );
}
