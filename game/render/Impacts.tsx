import React from "react";
import * as THREE from "three";
import type { Impact } from "@/game/domain/types";
import { NEVER_RAYCAST } from "@/game/render/instancing";

/** Shared by every bullet decal; there are only ever a couple of dozen. */
const IMPACT_GEOMETRY = new THREE.SphereGeometry(0.06, 8, 8);
const IMPACT_MATERIAL = new THREE.MeshBasicMaterial({ color: "#ffe600" });

/** Bullet decals left behind by previous shots. */
export function Impacts({ impacts }: { impacts: Impact[] }): React.ReactElement {
  return (
    <group>
      {impacts.map((impact) => (
        <mesh
          key={impact.id}
          position={impact.position}
          geometry={IMPACT_GEOMETRY}
          material={IMPACT_MATERIAL}
          raycast={NEVER_RAYCAST}
        />
      ))}
    </group>
  );
}
