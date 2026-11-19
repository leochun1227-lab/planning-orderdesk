"""Allocate the existing MY2027 Stock places, retaining both dealer first arrivals."""

import json
import sys
from datetime import date, timedelta
from calendar import monthrange
import numpy as np
from scipy.optimize import Bounds, LinearConstraint, linear_sum_assignment, milp
from scipy.sparse import lil_matrix


def solve(live):
    D = {d["slug"]: d for d in live["dealers"]}
    jobs = live["jobs"]
    A = {a["chassis"]: a for a in live["originals"]}
    immutable = live["fixed"]
    ass = live["assumptions"]
    start = date.fromisoformat(live["today"])
    selected = {v["chassis"] for v in jobs}

    def eligible(a):
        return (
            str(a["modelYear"]) == "2027"
            and a["policy"] == "display"
            and a["model"].upper().startswith(("SRC", "SRP"))
        )

    def protect_in_place():
        # For infeasible date/assortment edits, retain original first stock in
        # the existing places. Only release surplus after a retained arrival.
        retained = {}
        changed = {}
        for a in sorted(
            jobs, key=lambda a: (min(a["plannedAu"], a.get("originalAu") or a["plannedAu"]), a["slotOrder"])
        ):
            owner = a["from"]
            pair = (owner, a["model"][:3].upper())
            if owner not in target or not admissible(a, owner):
                continue
            deadline = min(a["plannedAu"], a.get("originalAu") or a["plannedAu"])
            known = covered.get(pair)
            transit = D[owner]["lead"]
            if known and (known == live["today"] or transit is not None and known <= add(deadline, transit)):
                continue
            if retained.get(pair, "9999") > deadline or a["to"] == owner:
                retained[pair] = min(a["plannedAu"], retained.get(pair, "9999"))
                if a["to"] != owner:
                    changed[a["slotOrder"]] = [a["slotOrder"], a["chassis"], owner, True]
        return list(changed.values())

    def offset(s):
        return (date.fromisoformat(s) - start).days

    def isoday(i):
        return (start + timedelta(days=int(i))).isoformat()

    def add(d, n):
        return isoday(offset(d) + n)

    def slug_pair(a):
        return (a["from"], a["model"].upper()[:3])

    def admissible(a, s):
        return a["model"].upper() in D[s]["assumptions"]["models"]

    def first_day(a):
        return min([v for v in (a.get("originalAu"), a.get("plannedAu")) if v] or ["9999"])

    target = [s for s, d in D.items() if s != "traralgon" and d["assumptions"]["receiving"]]
    pairs = [
        (s, k)
        for s in sorted(target)
        for k in ("SRC", "SRP")
        if any(m.startswith(k) for m in D[s]["assumptions"]["models"])
    ]
    due, first = {}, {}
    for s, k in pairs:
        originals = [
            a
            for a in A.values()
            if eligible(a)
            and a["from"] == s
            and a["model"].upper().startswith(k)
            and admissible(a, s)
            and a["group"] in ("locked", "au", "sea", "cn", "rolling")
            and a["originalAu"]
            and a["action"] != "cancel"
        ]
        due[s, k] = min((a["originalAu"] for a in originals), default=None)
        options = [a for a in jobs if slug_pair(a) == (s, k) and admissible(a, s)]
        if options:
            # If the original earliest unit is on the active schedule, retain it.
            # Among tied source dates, prefer an existing early production place.
            first[s, k] = min(
                options,
                key=lambda a: (
                    a.get("originalAu") != due[s, k] if due[s, k] else False,
                    first_day(a),
                    a["plannedAu"],
                    a["to"] != s,
                    a["chassis"],
                ),
            )
    # Existing yard and dated inbound units can satisfy a range without a new order.
    covered = {}
    for slug, family in pairs:
        if any(
            v["model"].upper().startswith(family) and v["model"].upper() in D[slug]["assumptions"]["models"]
            for v in D[slug]["my2027Yard"]
        ):
            covered[slug, family] = live["today"]
        else:
            dates = [
                a["plannedArrival"]
                for a in immutable
                if eligible(a)
                and a["to"] == slug
                and a["model"].upper().startswith(family)
                and admissible(a, slug)
            ]
            if dates:
                covered[slug, family] = min(dates)
    if not ass.get("exchangeSlots", True):
        return protect_in_place()
    for pair, arrival in covered.items():
        lead = D[pair[0]]["lead"]
        if (
            arrival == live["today"]
            or lead is not None
            and arrival <= add(min(a["plannedAu"] for a in jobs), lead)
        ):
            first.pop(pair, None)
            due.pop(pair, None)
    pairs = [p for p in pairs if p in due]
    missing = [pair for pair in pairs if pair not in first]
    reserved_ids = {a["chassis"] for a in first.values()}
    surplus = [a for a in jobs if a["chassis"] not in reserved_ids]
    M = np.full((len(missing), len(surplus) + len(missing)), 1e10)
    M[:, len(surplus) :] = 1e8
    for i, (s, k) in enumerate(missing):
        for j, a in enumerate(surplus):
            if a["model"].upper()[:3] != k or not admissible(a, s):
                continue
            # Retain a current transfer if it already serves this store, and
            # avoid creating two movements when an outgoing job is available.
            M[i, j] = (
                (a["to"] != s) * 2000
                + (a["from"] == a["to"]) * 300
                + offset(a["plannedAu"]) * 0.1
                + j * 0.0001
            )
    if missing:
        row, col = linear_sum_assignment(M)
        for i, j in zip(row, col):
            if j < len(surplus) and M[i, j] < 1e8:
                first[missing[i]] = surplus[j]
    pairs = [p for p in pairs if p in first]
    if not pairs:
        return protect_in_place() if not covered else []
    assert len({a["chassis"] for a in first.values()}) == len(pairs)
    # Match the first wave to actual MY2027 Stock places. The sender's first
    # cannot finish later than any first-wave order it supplies to another dealer.
    days = sorted(set(a["plannedAu"] for a in jobs if a["plannedAu"] <= "2027-04-30"))
    if not days or sum(a["plannedAu"] in days for a in jobs) < len(pairs):
        days = sorted({a["plannedAu"] for a in jobs})
    places_by_day = {
        d: sorted((a for a in jobs if a["plannedAu"] == d), key=lambda a: a["slotOrder"]) for d in days
    }
    ds = np.array([offset(d) for d in days])
    day0 = ds[0]
    T = len(days)
    J = len(pairs)
    n = J * T + 1
    lo = np.zeros(n)
    hi = np.ones(n)
    hi[-1] = 1000
    cost = np.zeros(n)
    cost[-1] = 150
    constraints = []

    def con(terms, l, u):
        constraints.append((terms, l, u))

    for j, (s, k) in enumerate(pairs):
        a = first[s, k]
        lead = D[s]["lead"]
        orig = due[s, k]
        override = ass["finishDates"].get(a["chassis"], "")
        for t, d in enumerate(days):
            if (
                (not a.get("signed") and all(v["schedulePart"] == "following" for v in places_by_day[d]))
                or d < override
                or (orig and d > max(orig, days[0], override))
            ):
                hi[j * T + t] = 0
            dt = int(ds[t]) - day0
            if lead is not None:
                arrival = add(d, lead)
                cost[j * T + t] = 35000 * (arrival > "2027-04-07") + 10000 * (arrival > "2027-03-31") + dt * 3
            else:
                cost[j * T + t] = dt * 2
            # Prefer leaving an existing destination/slot unchanged on time ties.
            cost[j * T + t] += (
                (0 if any(v["to"] == s for v in places_by_day[d]) else 0.2)
                + abs(offset(a["plannedAu"]) - int(ds[t])) * 0.0005
                + (j + 1) * (t + 1) * 1e-6
            )
        con({j * T + t: 1 for t in range(T)}, 1, 1)
        if lead is not None:
            con({**{j * T + t: int(ds[t] - day0) + lead for t in range(T)}, n - 1: -1}, -np.inf, 0)
        donor = slug_pair(a)
        if donor in pairs and donor != (s, k):
            dj = pairs.index(donor)
            con(
                {
                    **{dj * T + t: int(ds[t] - day0) for t in range(T)},
                    **{j * T + t: -int(ds[t] - day0) for t in range(T)},
                },
                -np.inf,
                0,
            )
    for t, d in enumerate(days):
        con({j * T + t: 1 for j in range(J)}, 0, len(places_by_day[d]))
    mat = lil_matrix((len(constraints), n))
    for i, (terms, _, _) in enumerate(constraints):
        for k, v in terms.items():
            mat[i, k] = v
    sol = milp(
        cost,
        integrality=np.r_[np.ones(n - 1), 0],
        bounds=Bounds(lo, hi),
        constraints=LinearConstraint(mat.tocsr(), [v[1] for v in constraints], [v[2] for v in constraints]),
        options={"mip_rel_gap": 0, "time_limit": 35},
    )
    if sol.x is None:
        return protect_in_place()
    first_au = {p: days[np.argmax(sol.x[i * T : (i + 1) * T])] for i, p in enumerate(pairs)}
    placement = {}
    owners = {}
    anchors = {}

    def put(slot, a, s, anchor=False):
        assert slot["slotOrder"] not in placement
        placement[slot["slotOrder"]] = a
        owners[slot["slotOrder"]] = s
        if anchor:
            anchors[a["chassis"]] = (s, a["model"][:3].upper())

    for d in days:
        p = [pair for pair in pairs if first_au[pair] == d]
        if not p:
            continue
        slots = places_by_day[d]
        C = [
            [
                0
                if first[pair]["chassis"] == v["chassis"] and pair[0] == v["to"]
                else (0 if pair[0] == v["to"] else 10)
                + (0 if v["model"] == first[pair]["model"] else 2)
                + (0.01 if v["group"] != first[pair]["group"] else 0)
                for v in slots
            ]
            for pair in p
        ]
        for i, pair in enumerate(p):
            if not first[pair].get("signed"):
                for j, v in enumerate(slots):
                    if v["schedulePart"] == "following":
                        C[i][j] = 1e10
        rr, cc = linear_sum_assignment(C)
        if any(C[i][j] >= 1e9 for i, j in zip(rr, cc)):
            return protect_in_place()
        for i, j in zip(rr, cc):
            put(slots[j], first[p[i]], p[i][0], True)
    # Exact daily reflection of stock at zero using the same aggregate handovers
    # as the live simulator. First re-create the live monthly figures as a check.
    end = max(
        offset(live["planningEnd"]),
        max(offset(v["plannedAu"]) for v in jobs) + max((v["lead"] or 0 for v in D.values()), default=0) + 32,
    )
    N = end + 1
    days_elapsed = np.arange(1, N + 1)

    def curve(s, events):
        d = D[s]
        raw = d["assumptions"]["currentStock"] + events.cumsum() - days_elapsed * (d["weeklyStock"] / 7)
        return raw - np.minimum.accumulate(np.minimum(raw, 0))

    def pulse(e, s, day):
        if day and offset(day) <= end:
            e[s][max(0, offset(day))] += 1

    fixed = {s: np.zeros(N) for s in D}
    for a in immutable:
        pulse(fixed, a["to"], a["plannedArrival"])
    baseline_events = {s: v.copy() for s, v in fixed.items()}
    for a in jobs:
        pulse(baseline_events, a["to"], a["plannedArrival"])
    base_curves = {s: curve(s, e) for s, e in baseline_events.items()}
    events = {s: e.copy() for s, e in fixed.items()}
    for (s, k), d in first_au.items():
        if D[s]["lead"] is not None:
            pulse(events, s, add(d, D[s]["lead"]))
    current = {s: curve(s, e) for s, e in events.items()}
    # Under an already high source plan, only the two protected firsts are a
    # new exception. Never expand the network production schedule. Route
    # remaining places preferentially under cap and to lower closing ratios.
    ceilings = {
        s: np.maximum.reduce([base_curves[s], current[s], np.full(N, d["cap"])])
        for s, d in D.items()
        if d["cap"] is not None
    }
    spares = [a for a in sorted(jobs, key=lambda a: a["slotOrder"]) if a["slotOrder"] not in placement]
    regular = [s for s in target if D[s]["lead"] is not None and D[s]["cap"] is not None and D[s]["target"]]

    def month_end(date_string):
        d = date.fromisoformat(date_string)
        return offset(d.replace(day=monthrange(d.year, d.month)[1]).isoformat())

    for slot in spares:
        candidates = []
        for s in regular:
            if not admissible(slot, s):
                continue
            d = D[s]
            arrival = add(slot["plannedAu"], d["lead"])
            t = offset(arrival)
            last = month_end(arrival)
            test = events[s].copy()
            test[t] += 1
            after = curve(s, test)
            before = current[s]
            worse = float(np.maximum(after - ceilings[s], 0).max())
            cap_pressure = float(
                np.maximum(np.maximum(after - d["cap"], 0) - np.maximum(before - d["cap"], 0), 0).max()
            )
            # Only compare tolerances to avoid arbitrary ordering from float noise.
            key = (
                round(worse, 7),
                round(cap_pressure, 7) > 0,
                round(after[last] / d["target"], 7),
                s != slot["to"],
                s != slot["from"],
                s,
            )
            candidates.append((key, s, t, after))
        if not candidates:
            return protect_in_place()
        _, s, t, after = min(candidates, key=lambda x: x[0])
        events[s][t] += 1
        current[s] = after
        owners[slot["slotOrder"]] = s
    # Assign actual vehicles to the remaining balanced destination/date places.
    # Keep existing recommended model variety in the receiving slots, then
    # minimise source dealer changes and date moves. No outgoing vehicle may
    # beat its original dealer's own first of that range on arrival.
    remaining = [v for v in jobs if v["chassis"] not in anchors]
    C = np.full((len(spares), len(remaining)), 1e10)
    for i, slot in enumerate(spares):
        s = owners[slot["slotOrder"]]
        d = slot["plannedAu"]
        for j, v in enumerate(remaining):
            if not admissible(v, s) or ass["finishDates"].get(v["chassis"], "") > d:
                continue
            if slot["schedulePart"] == "following" and not v.get("signed"):
                continue
            donor = slug_pair(v)
            if v["from"] != s:
                deadline = min(d, v.get("originalAu") or d)
                retained = first_au.get(donor)
                lead = D[v["from"]]["lead"]
                in_time = donor in covered and (
                    covered[donor] == live["today"]
                    or lead is not None
                    and covered[donor] <= add(deadline, lead)
                )
                if (
                    donor[0] in target
                    and admissible(v, donor[0])
                    and not in_time
                    and (not retained or retained > deadline)
                ):
                    continue
            C[i, j] = (
                (v["from"] != s) * 100000
                + (v["model"].upper()[:3] != slot["model"].upper()[:3]) * 110
                + (v["model"].upper() != slot["model"].upper()) * 20
                + (v["to"] != s) * 7
                + abs(offset(v["plannedAu"]) - offset(d)) * 0.02
                + (v["chassis"] != slot["chassis"]) * 0.001
            )
    rr, cc = linear_sum_assignment(C)
    if len(rr) != len(spares) or (len(rr) and np.max(C[rr, cc]) >= 1e9):
        return protect_in_place()
    for i, j in zip(rr, cc):
        put(spares[i], remaining[j], owners[spares[i]["slotOrder"]])
    assert len(placement) == len(selected) and {v["chassis"] for v in placement.values()} == selected
    return [[i, a["chassis"], owners[i], a["chassis"] in anchors] for i, a in placement.items()]


if __name__ == "__main__":
    print(json.dumps(solve(json.load(sys.stdin))))
