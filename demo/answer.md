# RA³ demo — Q → R → A

This walks the full pipeline for the hard finite-difference question, one sub-question at a time:

- **Q** = the question asked
- **R** = what retrieval returned (verbatim chunks from the KB, with page numbers)
- **A** = the answer assembled from that evidence (with `(source: …, p. N)` citations)

Corpus: *Finite Difference Computing with PDEs* (Langtangen & Linge, Springer 2017), indexed as
`langtangen-fdm` (2098 chunks). Retrieval = 3-leg hybrid (dense BGE-M3 + BM25 + learned-sparse,
RRF-fused). Page numbers are **PDF pages** as stored in the KB (book page = PDF page − 24).

---

# Q — the question

Answer all three parts with exact formulas, citing `(source: langtangen-fdm, p. N)` per claim.

**(a) Diffusion, θ-rule and leapfrog.** For `u_t = α u_xx`:
1. derive the Crank–Nicolson amplification factor and state its stability / oscillation
   condition (in terms of F = αΔt/Δx²);
2. derive the leapfrog quadratic for the amplification factor, give its two roots, and explain
   why the scheme is *always* unstable for this equation — and why it works well for
   first-order-in-space PDEs.

**(b) Advection, leapfrog and CFL.**
1. state the CFL condition (inequality in Δt, Δx and v);
2. give the leapfrog amplification factor and the exact one it approximates;
3. explain what happens at C = 1 vs C < 1.

**(c) Nonlinear diffusion solver.** For `∂u/∂t = ∇·(α(u)∇u) + f(u)`:
1. state the explicit (Forward Euler) stability limit for the 3D case with f = 0;
2. write the Backward Euler + **Picard iteration** scheme (equation numbers as in the book);
3. write the **Newton** linearization as a correction equation for δu (Taylor-expanded), and
   state how the iteration is seeded each time level.

---

# R → A

## (a1) Crank–Nicolson amplification factor

**Q.** Derive the CN amplification factor; state its stability / oscillation condition in terms of `F = αΔt/Δx²`.

**R.** Retrieved from the KB:

> The Crank-Nicolson scheme can be written as `[D_t u = α D_x D_x u]^{n+½}` …
> *(chunk 43306, p. 307, §3.3.6 "Analysis of the Crank-Nicolson scheme")*
>
> `A = (1 − 2F sin²p) / (1 + 2F sin²p)`  (eq. 3.61)
> *(chunk 43311, p. 307)*
>
> "Stability. The criteria A > −1 and A < 1 are fulfilled for any ∆t > 0. Therefore, the
> solution cannot grow, but it will oscillate if `1 − 2F sin²p < 0`. To avoid such
> non-physical oscillations, we must demand F ≤ ½."
> *(chunk 43314, p. 307)*

**A.**
```
A = (1 − 2F sin²p) / (1 + 2F sin²p),    F = αΔt/Δx²,  p = kΔx/2      (eq. 3.61)
```
- **Stable for any Δt > 0** (unconditionally stable): `A > −1` and `A < 1` always hold.
- **Oscillates** when the numerator flips sign, i.e. `1 − 2F sin²p < 0`; avoid this with **`F ≤ ½`**.
*(source: langtangen-fdm, p. 307)*

---

## (a2) Leapfrog for diffusion

**Q.** Derive the leapfrog quadratic, give its two roots, and explain why it is always unstable for `u_t = αu_xx` — yet works for first-order-in-space PDEs.

**R.** Retrieved from the KB:

> "We can get an explicit second-order scheme in time by using the Leapfrog method: … Written
> out, `u_i^{n+1} = u_i^{n−1} + (2α∆t/∆x²)(u_{i+1}^n − 2u_i^n + u_{i−1}^n) + f`. … We need some
> formula for the first step `u¹` … we can use a Forward Euler step. Unfortunately, the Leapfrog
> scheme is always unstable …"
> *(chunk 43317, p. 308, §3.3.7)*
>
> `A² + 4F sin²p·A − 1 = 0`, which has roots …
> *(chunk 43318, p. 308)*
>
> "`A = −2F sin²p ± √(4F⁴ sin⁴p + 1)`. Both roots have |A| > 1 so the amplitude always grows …
> However, for a PDE with a first-order derivative in space, instead of a second-order one, the
> Leapfrog scheme performs very well. Details are provided in Section 4.1.3."
> *(chunk 43319, p. 308)*

**A.**
```
u_i^{n+1} = u_i^{n−1} + (2αΔt/Δx²)(u_{i+1}^n − 2u_i^n + u_{i−1}^n) + f     (first step: Forward Euler)

A² + 4F sin²p·A − 1 = 0   ⇒   A = −2F sin²p ± √(4F⁴ sin⁴p + 1)
```
- **Always unstable:** both roots satisfy `|A| > 1` → the amplitude always grows.
- **Works for first-order-in-space PDEs** because the instability is specific to the second-order
  (diffusion) case; leapfrog performs very well for first-order-in-space equations (Section 4.1.3).
*(source: langtangen-fdm, p. 308)*

---

## (b1) CFL condition

**Q.** State the CFL condition (inequality in Δt, Δx, v).

**R.** Retrieved from the KB:

> "Stability. For all the working schemes to be presented in this chapter, we get the stability
> condition C ≤ 1: `∆t ≤ ∆x/v`. This is called the CFL condition and applies almost always to
> successful schemes for advection problems."
> *(chunk 43629, p. 418)*

**A.**
```
Δt ≤ Δx/v        (C ≤ 1,  where C = vΔt/Δx is the Courant number)
```
*(source: langtangen-fdm, p. 418)*

---

## (b2) Leapfrog amplification factor (advection)

**Q.** Give the leapfrog amplification factor and the exact one it approximates.

**R.** Retrieved from the KB:

> "`A = −iC sin p ± √(1 − C² sin²p)`, and is to be compared to the exact amplification factor
> `A_e = e^{−ikv∆t} = e^{−ikC∆x} = e^{−iCp}`."
> *(chunk 43630, p. 418)*

**A.**
```
A   = −iC sin p ± √(1 − C² sin²p)
A_e = e^{−ikvΔt} = e^{−ikCΔx} = e^{−iCp}
```
*(source: langtangen-fdm, p. 418)*

---

## (b3) C = 1 vs C < 1

**Q.** What happens to the numerical solution at C = 1 vs C < 1?

**R.** Retrieved from the KB:

> "… `u_i^{n+1} = u_i^n − C(u_i^n − u_{i−1}^n)` gives a generally popular and robust scheme that
> is stable if C ≤ 1. As with the Leapfrog scheme, it becomes exact if C = 1 … However, any C < 1
> gives a significant reduction in the amplitude of the [solution]."
> *(chunk 43633, p. 419)*

**A.**
- **C = 1** → the scheme is **exact** (no numerical error).
- **C < 1** → **significant amplitude reduction** (numerical damping).
*(source: langtangen-fdm, p. 419)*

---

## (c1) Explicit (Forward Euler) stability limit

**Q.** State the explicit stability limit for the 3D case with f = 0.

**R.** Retrieved from the KB:

> "… `u^{n+1} = u^n + ∆t∇·(α(u^n)∇u^n) + ∆t f(u^n)`. The disadvantage with this discretization
> is the strict stability criterion `∆t ≤ h²/(6 max α)` for the case f = 0 and a standard
> 2nd-order finite difference discretization in 3D."
> *(chunk 43868, p. 470, §5.3.1)*

**A.**
```
u^{n+1} = u^n + Δt ∇·(α(u^n)∇u^n) + Δt f(u^n)

Δt ≤ h²/(6 max α)          (3D, f = 0, 2nd-order FD)
```
*(source: langtangen-fdm, p. 470)*

---

## (c2) Backward Euler + Picard iteration

**Q.** Write the Backward Euler + Picard scheme (equation numbers as in the book).

**R.** Retrieved from the KB:

> "A Backward Euler scheme for (5.30) reads `[D_t u = ∇·(α(u)∇u) + f(u)]`. Written out,
> `(u^n − u^{n−1})/∆t = ∇·(α(u^n)∇u^n) + f(u^n)` (5.33). … We introduce a Picard iteration
> with k as iteration count …"
> *(chunk 43869, p. 470, §5.3.2)*
>
> "The initial guess for the Picard iteration at this time level can be taken as the solution at
> the previous time level: `u^{n,0} = u^{n−1}`. … The PDE to be solved in a Picard iteration then
> looks like `(u − u⁻)/∆t = ∇·(α(u⁻)∇u) + f(u⁻)` (5.35)."
> *(chunk 43870, p. 471)*

**A.**
```
BE (5.33):  (u^n − u^{n−1})/Δt = ∇·(α(u^n)∇u^n) + f(u^n)

Picard (5.35):  (u − u⁻)/Δt = ∇·(α(u⁻)∇u) + f(u⁻)
                u  = u^{n,k+1} (unknown),   u⁻ = u^{n,k} (most recent value)
```
**Seeding:** start each time level from the previous one, `u^{n,0} = u^{n−1}`.
*(source: langtangen-fdm, pp. 470–471)*

---

## (c3) Newton linearization

**Q.** Write the Newton linearization as a correction equation for δu (Taylor-expanded), and state the seeding.

**R.** Retrieved from the KB:

> "Let `u^{n,k}` be an approximation to the unknown `u^n`. We seek a better approximation on the
> form `u = u^{n,k} + δu` (5.36). The idea is to insert (5.36) in (5.33), Taylor expand the
> nonlinearities and keep only the terms that are linear in δu … Inserting (5.36) in (5.33) gives
> `(u^{n,k} + δu − u^{n−1})/∆t = ∇·(α(u^{n,k}+δu)∇(u^{n,k}+δu)) + f(u^{n,k}+δu)` (5.37).
> We can Taylor expand … `α(u^{n,k}+δu) = α(u^{n,k}) + (dα/du)(u^{n,k})δu + O(δu²) ≈ α(u^{n,k}) + α′(u^{n,k})δu`,
> `f(u^{n,k}+δu) ≈ f(u^{n,k}) + f′(u^{n,k})δu`. Inserting … results in … (5.38)."
> *(chunk 43872, p. 472, §5.3.3)*

**A.**
```
Newton step (5.36):  u = u^{n,k} + δu

Insert into (5.33) → (5.37):
  (u^{n,k} + δu − u^{n−1})/Δt = ∇·(α(u^{n,k}+δu) ∇(u^{n,k}+δu)) + f(u^{n,k}+δu)

Taylor-expand (linear in δu):
  α(u^{n,k}+δu) ≈ α(u^{n,k}) + α′(u^{n,k}) δu
  f(u^{n,k}+δu) ≈ f(u^{n,k}) + f′(u^{n,k}) δu

→ (5.38): a LINEAR PDE for the correction δu   (drop the O(δu²) term α′(u^{n,k})δu ∇δu)
→ update:  u^{n,k+1} = u^{n,k} + δu
```
**Seeding:** each time level starts from the previous one, `u^{n,0} = u^{n−1}` (same as Picard).
*(source: langtangen-fdm, pp. 471–472)*

---

## Retrieval trace (summary)

| sub-question | expected (book p. / PDF p.) | retrieved (PDF p., chunk) | ✓ |
|---|---|---|---|
| (a1) CN factor | 283 / 307 | 307 (43306, 43311, 43314) | ✓ |
| (a2) leapfrog diffusion | 284 / 308 | 308 (43317, 43318, 43319) | ✓ |
| (b1) CFL | 394 / 418 | 418 (43629) | ✓ |
| (b2) leapfrog advection | 394 / 418 | 418 (43630) | ✓ |
| (b3) C=1 vs C<1 | 395 / 419 | 419 (43633) | ✓ |
| (c1) explicit limit | 446 / 470 | 470 (43868) | ✓ |
| (c2) Picard | 447 / 471 | 470–471 (43869, 43870) | ✓ |
| (c3) Newton | 448 / 472 | 472 (43872) | ✓ |

All eight sub-questions hit the expected location exactly.
