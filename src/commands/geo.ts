// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import type { Executor } from "../executor.js";
import { formatFloat } from "../internal/numbers.js";
import { arr, num, str, strOrNull } from "../resp/decode.js";
import type { CommandArg, RespValue } from "../resp/types.js";

export interface GeoPoint {
  longitude: number;
  latitude: number;
  member: CommandArg;
}

export interface GeoSearchOptions {
  /** Search from a member already in the set instead of fromLonLat. */
  fromMember?: string;
  fromLonLat?: [number, number];
  byRadius?: { radius: number; unit: "m" | "km" | "mi" | "ft" };
  byBox?: { width: number; height: number; unit: "m" | "km" | "mi" | "ft" };
  asc?: boolean;
  desc?: boolean;
  count?: number;
  any?: boolean;
  withCoord?: boolean;
  withDist?: boolean;
  withHash?: boolean;
}

export interface GeoSearchResult {
  member: string;
  distance?: string;
  hash?: string;
  coordinates?: [string, string];
}

function searchArgs(key: string, opts: GeoSearchOptions): CommandArg[] {
  const args: CommandArg[] = ["GEOSEARCH", key];
  if (opts.fromMember !== undefined) args.push("FROMMEMBER", opts.fromMember);
  if (opts.fromLonLat !== undefined) args.push("FROMLONLAT", formatFloat(opts.fromLonLat[0], "longitude"), formatFloat(opts.fromLonLat[1], "latitude"));
  if (opts.byRadius !== undefined) args.push("BYRADIUS", formatFloat(opts.byRadius.radius, "radius"), opts.byRadius.unit);
  if (opts.byBox !== undefined) args.push("BYBOX", formatFloat(opts.byBox.width, "width"), formatFloat(opts.byBox.height, "height"), opts.byBox.unit);
  if (opts.asc) args.push("ASC");
  if (opts.desc) args.push("DESC");
  if (opts.count !== undefined) args.push("COUNT", opts.count);
  if (opts.any) args.push("ANY");
  if (opts.withCoord) args.push("WITHCOORD");
  if (opts.withDist) args.push("WITHDIST");
  if (opts.withHash) args.push("WITHHASH");
  return args;
}

function decodeSearchResults(v: RespValue, opts: GeoSearchOptions): GeoSearchResult[] {
  const anyExtra = Boolean(opts.withCoord || opts.withDist || opts.withHash);
  return arr(v).map((item) => {
    if (!anyExtra) return { member: str(item) };
    const parts = arr(item);
    let i = 1;
    const result: GeoSearchResult = { member: str(parts[0] as RespValue) };
    if (opts.withDist) result.distance = str(parts[i++] as RespValue);
    if (opts.withHash) result.hash = str(parts[i++] as RespValue);
    if (opts.withCoord) {
      const coord = arr(parts[i++] as RespValue);
      result.coordinates = [str(coord[0] as RespValue), str(coord[1] as RespValue)];
    }
    return result;
  });
}

export interface GeoCommands {
  /** GEOADD key longitude latitude member [...]. */
  geoAdd(key: string, points: GeoPoint[]): Promise<number>;
  /** GEOPOS key member [member ...]: [lon, lat] per member, or null where absent. */
  geoPos(key: string, ...members: string[]): Promise<Array<[string, string] | null>>;
  /** GEODIST key member1 member2 [unit]. */
  geoDist(key: string, member1: string, member2: string, unit?: "m" | "km" | "mi" | "ft"): Promise<string | null>;
  /** GEOHASH key member [member ...]. */
  geoHash(key: string, ...members: string[]): Promise<Array<string | null>>;
  /** GEOSEARCH key FROMMEMBER|FROMLONLAT BYRADIUS|BYBOX [options]. */
  geoSearch(key: string, opts: GeoSearchOptions): Promise<GeoSearchResult[]>;
}

export function installGeoCommands(proto: object): void {
  Object.assign(proto, {
    async geoAdd(this: Executor, key: string, points: GeoPoint[]) {
      const args: CommandArg[] = ["GEOADD", key];
      for (const p of points) args.push(formatFloat(p.longitude, "longitude"), formatFloat(p.latitude, "latitude"), p.member);
      return num(await this.execute(args));
    },
    async geoPos(this: Executor, key: string, ...members: string[]) {
      return arr(await this.execute(["GEOPOS", key, ...members])).map((v) => {
        if (v === null) return null;
        const [lon, lat] = arr(v);
        return [str(lon as RespValue), str(lat as RespValue)] as [string, string];
      });
    },
    async geoDist(this: Executor, key: string, member1: string, member2: string, unit?: "m" | "km" | "mi" | "ft") {
      const args: CommandArg[] = ["GEODIST", key, member1, member2];
      if (unit !== undefined) args.push(unit);
      return strOrNull(await this.execute(args));
    },
    async geoHash(this: Executor, key: string, ...members: string[]) {
      return arr(await this.execute(["GEOHASH", key, ...members])).map((v) => (v === null ? null : str(v)));
    },
    async geoSearch(this: Executor, key: string, opts: GeoSearchOptions) {
      return decodeSearchResults(await this.execute(searchArgs(key, opts)), opts);
    },
  });
}
