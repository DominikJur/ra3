# Demo: RA³ on a hard finite-difference question

The demo shows the whole loop: **index a real book → retrieve → answer with page citations**.
It uses a question that plain LLMs get wrong or refuse to detail, but whose exact answer sits
in the corpus.

## Corpus

*Finite Difference Computing with PDEs: A Modern Software Approach* (Langtangen & Linge,
Springer 2017, **CC BY 4.0**). Fetch it with `./fetch-corpus.sh` (verified mirror on the
author's site, ~5.7 MB), then index:

```
document_index({ source: "<abs path to books/langtangen_fdm.pdf>", name: "langtangen-fdm" })
```

The doc is searchable immediately after the call returns.

## The demo question

Answer all three parts with exact formulas, citing `(source: langtangen-fdm, p. N)` per claim.

**(a) Diffusion, θ-rule and leapfrog.** For `u_t = α u_xx`:

- derive the amplification factor of the Crank–Nicolson scheme and state its stability /
  oscillation condition (in terms of F = αΔt/Δx²);
- derive the leapfrog scheme's quadratic for the amplification factor, give its two roots,
  and explain why the scheme is *always* unstable for this equation and why it works well
  for first-order-in-space PDEs.

**(b) Advection, leapfrog and CFL.** For the linear advection equation with the working
schemes of chapter 4:

- state the CFL condition (inequality in Δt, Δx and v);
- give the leapfrog amplification factor and the exact one it approximates;
- explain what happens to a numerical solution at C = 1 vs C < 1.

**(c) Nonlinear diffusion solver.** For `∂u/∂t = ∇·(α(u)∇u) + f(u)`:

- state the explicit (Forward Euler) stability limit for the 3D case with f = 0;
- write the Backward Euler + **Picard iteration** scheme (equation numbers as in the book);
- write the **Newton** linearization as a correction equation for δu (Taylor-expanded),
  and state how the iteration is seeded each time level.

## Expected evidence (what retrieval should surface)

| part | expected source (book p. / PDF p.) | content |
|---|---|---|
| (a) CN factor | book 283 / PDF 307 | `A = (1 − 2F sin²p)/(1 + 2F sin²p)`, stable ∀Δt, oscillates unless F ≤ ½ |
| (a) leapfrog | book 284 / PDF 308 | `A² + 4F sin²p·A − 1 = 0`, roots `A = −2F sin²p ± √(4F⁴ sin⁴p + 1)`, both `\|A\| > 1` |
| (b) CFL | book 394 / PDF 418 | `C ≤ 1`, `Δt ≤ Δx/v`; `A = −iC sin p ± √(1 − C² sin²p)` vs exact `e^(−iCp)` |
| (b) C=1 vs C<1 | book 395 / PDF 419 | leapfrog exact at C = 1; C < 1 → amplitude reduction |
| (c) explicit limit | book 446 / PDF 470 | `Δt ≤ h²/(6 max α)` (3D, f = 0) |
| (c) Picard | book 447 / PDF 471 | eq. (5.35): `(u − u⁻)/Δt = ∇·(α(u⁻)∇u) + f(u⁻)`, seeded from previous time level |
| (c) Newton | book 448 / PDF 472 | eqs. (5.36)–(5.37): `u = u^(n,k) + δu`, Taylor-expand, solve linear PDE for δu |

(Page numbers are the **PDF** page numbers as stored in the KB: the book's printed page is
PDF − 24.)

## Run

```bash
node demo/retrieve.mjs                 # 3-leg retrieval for the three parts
```

Then assemble the answer, citing each chunk as `(source: langtangen-fdm, p. N)`.
