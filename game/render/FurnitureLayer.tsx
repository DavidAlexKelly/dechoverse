import React, { useEffect, useMemo, useState } from "react";
import type * as THREE from "three";
import { loadObjectModel } from "@/foundry/models";
import type { PlacedObject } from "@/game/domain/types";
import { FURNITURE_SCALE, modelPathOf } from "@/game/world/furnitureCatalog";

const WOOD = "#a9743f";
const WOOD_DARK = "#7d5230";

/**
 * Every mesh is individually marked shootable: userData is not inherited from
 * a parent group, and the mop finds props by hit-testing meshes.
 */
const SHOOTABLE = { shootable: true };

function Leg({
  x,
  z,
  height,
  thickness,
}: {
  x: number;
  z: number;
  height: number;
  thickness: number;
}): React.ReactElement {
  return (
    <mesh position={[x, height / 2, z]} userData={SHOOTABLE}>
      <boxGeometry args={[thickness, height, thickness]} />
      <meshStandardMaterial color={WOOD_DARK} />
    </mesh>
  );
}

function Chair(): React.ReactElement {
  const seatHeight = 0.45;
  const legThickness = 0.05;
  const half = 0.2;
  return (
    <group>
      <mesh position={[0, seatHeight, 0]} userData={SHOOTABLE}>
        <boxGeometry args={[0.46, 0.06, 0.46]} />
        <meshStandardMaterial color={WOOD} />
      </mesh>
      {/* Backrest sits behind the seat, so a chair faces the placer. */}
      <mesh position={[0, seatHeight + 0.3, 0.2]} userData={SHOOTABLE}>
        <boxGeometry args={[0.46, 0.55, 0.06]} />
        <meshStandardMaterial color={WOOD} />
      </mesh>
      <Leg x={-half} z={-half} height={seatHeight} thickness={legThickness} />
      <Leg x={half} z={-half} height={seatHeight} thickness={legThickness} />
      <Leg x={-half} z={half} height={seatHeight} thickness={legThickness} />
      <Leg x={half} z={half} height={seatHeight} thickness={legThickness} />
    </group>
  );
}

function Table(): React.ReactElement {
  const topHeight = 0.74;
  const legThickness = 0.07;
  const halfX = 0.55;
  const halfZ = 0.35;
  return (
    <group>
      <mesh position={[0, topHeight, 0]} userData={SHOOTABLE}>
        <boxGeometry args={[1.2, 0.07, 0.8]} />
        <meshStandardMaterial color={WOOD} />
      </mesh>
      <Leg x={-halfX} z={-halfZ} height={topHeight} thickness={legThickness} />
      <Leg x={halfX} z={-halfZ} height={topHeight} thickness={legThickness} />
      <Leg x={-halfX} z={halfZ} height={topHeight} thickness={legThickness} />
      <Leg x={halfX} z={halfZ} height={topHeight} thickness={legThickness} />
    </group>
  );
}

/**
 * One model prop.
 *
 * Each placed copy gets its own clone of the loaded scene: an Object3D can
 * only sit at one place in the graph, so the shared original would jump
 * between every copy of itself. Clones share geometry and materials, so the
 * cost is a node tree rather than a second copy of the mesh.
 *
 * Nothing is drawn until the model arrives. A placeholder box would be worse
 * than nothing here — it would sit inside whatever the real model turns out
 * to be, and pop out of it a moment later.
 */
function ModelProp({ path }: { path: string }): React.ReactElement | null {
  const [scene, setScene] = useState<THREE.Object3D | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadObjectModel(path)
      .then((model) => {
        if (!cancelled) {
          setScene(model.scene);
        }
      })
      .catch(() => {
        // A model that will not load simply does not appear. The prop is
        // still there in the stream and will show up if it loads later.
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const copy = useMemo(() => scene?.clone(true) ?? null, [scene]);
  return copy == null ? null : <primitive object={copy} />;
}

/**
 * Props placed with the objects tool. They are shootable so the mop can clear
 * them, but carry no targetId, so the select tool ignores them.
 */
export function FurnitureLayer({ objects }: { objects: PlacedObject[] }): React.ReactElement {
  return (
    <group>
      {objects.map((object) => {
        const path = modelPathOf(object.kind);
        // Model props are already sized and grounded by the library, so they
        // must not be put through the built-ins' fudge scale as well.
        return (
          <group
            key={object.id}
            position={object.position}
            rotation={[0, object.yaw, 0]}
            scale={path != null ? 1 : FURNITURE_SCALE}
          >
            {path != null ? (
              <ModelProp path={path} />
            ) : object.kind === "chair" ? (
              <Chair />
            ) : (
              <Table />
            )}
          </group>
        );
      })}
    </group>
  );
}
