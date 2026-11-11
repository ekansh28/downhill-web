/* Puppet prediction (finding 169): a remote rider shown at the present moment instead of in the
   past. From its newest snapshot the pose is carried forward by its velocity and angular velocity;
   when a newer snapshot moves the prediction, the difference is shown first and then fades
   (a large difference slower), so the rider never jumps, unless the difference is too large to be
   a misprediction (a respawn), where it snaps. When snapshots stop coming (Cloudflare's ~1 s
   stalls, finding 173) the rider carries on for a second, then slows and stops (finding 210).

   A rider's orientation is three rows (+0x1C0 of the rigid body, 4 floats each); its angular
   velocity (+0xD0) is in world space. Each row is a world-space axis of the rider, so over h
   seconds every row turns by the rotation of angle |w| h about w (checked against recorded paths:
   finding 169, "Prediction"). Pure functions on plain arrays, unit-tested (test_puppet_predict.c)
   and scored against simulated links with delay, jitter, loss and SFU stalls (test_puppet_sim.c,
   finding 210). */
#ifndef DHD_PUPPET_PREDICT_H
#define DHD_PUPPET_PREDICT_H
#include <math.h>
#include <string.h>

/* How a puppet is carried and corrected. Finding 210 chose the values (PUPPET_TUNE) by scoring them
   on simulated links (test_puppet_sim.c). */
typedef struct PuppetTune {
    double carry;      /* s: a snapshot is carried at full speed this far past its moment */
    double coast;      /* s: past that the velocity fades with this time constant (0: it stops) */
    double coast_max;  /* s: and the pose is held from this long after the snapshot */
    float tau;         /* s: a correction fades to 1/e in this time, */
    float fade_speed;  /* units/s: a large one slower, starting no faster than this (0: tau always) */
    float snap;        /* units: a larger jump is shown at once (a respawn, a teleport) */
    float rot_snap;    /* degrees: so is a larger turn (a trick's start or landing; 180: never) */
} PuppetTune;

#define PUPPET_TUNE {1.0, 0.5, 1.5, 0.08f, 90, 60, 30}

typedef struct PuppetPose {
    float pos[3];
    float rot[3][4];
} PuppetPose;

/* The rotation of angle |w| h about w (Rodrigues), as a 3x3 matrix acting on column vectors. */
static inline void predict_axis_angle(const float w[3], float h, float q[3][3])
{
    float n = sqrtf(w[0] * w[0] + w[1] * w[1] + w[2] * w[2]), a = n * h;
    memset(q, 0, 9 * sizeof(float));
    q[0][0] = q[1][1] = q[2][2] = 1;
    if (!(a > 1e-7f) || !isfinite(a)) return;
    float x = w[0] / n, y = w[1] / n, z = w[2] / n, c = cosf(a), s = sinf(a), C = 1 - c;
    q[0][0] = c + x * x * C,     q[0][1] = x * y * C - z * s, q[0][2] = x * z * C + y * s;
    q[1][0] = y * x * C + z * s, q[1][1] = c + y * y * C,     q[1][2] = y * z * C - x * s;
    q[2][0] = z * x * C - y * s, q[2][1] = z * y * C + x * s, q[2][2] = c + z * z * C;
}

/* The pose h seconds after (pos, rot) moving with vel (units a second) and spin (radians a second,
   world space). */
static inline void predict_pose(const float pos[3], const float rot[3][4], const float vel[3], const float spin[3],
                                float h, PuppetPose *out)
{
    float q[3][3];
    predict_axis_angle(spin, h, q);
    for (int k = 0; k < 3; k++) out->pos[k] = pos[k] + vel[k] * h;
    for (int i = 0; i < 3; i++) {
        for (int k = 0; k < 3; k++)
            out->rot[i][k] = q[k][0] * rot[i][0] + q[k][1] * rot[i][1] + q[k][2] * rot[i][2];
        out->rot[i][3] = rot[i][3];
    }
}

/* What is added to the raw prediction while a correction fades: a position offset and a rotation
   applied to the rows' combination (shown = E raw, E 3x3), each fading with its own time constant. */
typedef struct PuppetCorrection {
    float pos[3];
    float rot[3][3];
    float tau, rot_tau;  /* s: position, rotation */
    int on;
} PuppetCorrection;

static inline void correction_clear(PuppetCorrection *c)
{
    memset(c, 0, sizeof *c);
    c->rot[0][0] = c->rot[1][1] = c->rot[2][2] = 1;
}

/* The prediction moved from was (what was being shown) to raw: start showing was and fade to raw.
   The position fades 1/e in tau, a large difference slower: it starts no faster than fade_speed,
   so a long misprediction (a kicker taken while its snapshots were on the way, a stall) slides
   back instead of jumping. The rotation fades in tau, or is shown at once past rot_snap. Returns 0
   (and clears) when the position jumps more than snap. */
static inline int correction_fade(PuppetCorrection *c, const PuppetPose *was, const PuppetPose *raw, const PuppetTune *k)
{
    float d2 = 0;
    for (int i = 0; i < 3; i++) {
        c->pos[i] = was->pos[i] - raw->pos[i];
        d2 += c->pos[i] * c->pos[i];
    }
    if (!(d2 <= k->snap * k->snap)) {
        correction_clear(c);
        return 0;
    }
    float d = sqrtf(d2);
    c->tau = k->fade_speed > 0 && d > k->tau * k->fade_speed ? d / k->fade_speed : k->tau;
    c->rot_tau = k->tau;
    /* E = was raw^T (rows are orthonormal, so raw^T is raw's inverse) */
    for (int i = 0; i < 3; i++)
        for (int j = 0; j < 3; j++)
            c->rot[i][j] = was->rot[i][0] * raw->rot[j][0] + was->rot[i][1] * raw->rot[j][1] + was->rot[i][2] * raw->rot[j][2];
    /* E turns by the angle a with trace 1 + 2 cos a */
    if (c->rot[0][0] + c->rot[1][1] + c->rot[2][2] < 1 + 2 * cosf(k->rot_snap * 0.017453293f)) {
        memset(c->rot, 0, sizeof c->rot);
        c->rot[0][0] = c->rot[1][1] = c->rot[2][2] = 1;
    }
    c->on = 1;
    return 1;
}

/* dt seconds later: the correction is exp(-dt/tau) of what it was (rotation blended toward the
   identity, then made orthonormal again). */
static inline void correction_decay(PuppetCorrection *c, float dt)
{
    if (!c->on || !(dt > 0)) return;
    float keep_pos = expf(-dt / c->tau), keep = expf(-dt / c->rot_tau);
    for (int k = 0; k < 3; k++) c->pos[k] *= keep_pos;
    for (int i = 0; i < 3; i++)
        for (int j = 0; j < 3; j++) c->rot[i][j] = (i == j) + (c->rot[i][j] - (i == j)) * keep;
    for (int i = 0; i < 3; i++) {  /* Gram-Schmidt, rows */
        for (int j = 0; j < i; j++) {
            float d = c->rot[i][0] * c->rot[j][0] + c->rot[i][1] * c->rot[j][1] + c->rot[i][2] * c->rot[j][2];
            for (int k = 0; k < 3; k++) c->rot[i][k] -= d * c->rot[j][k];
        }
        float n = sqrtf(c->rot[i][0] * c->rot[i][0] + c->rot[i][1] * c->rot[i][1] + c->rot[i][2] * c->rot[i][2]);
        for (int k = 0; k < 3; k++) c->rot[i][k] /= n > 0 ? n : 1;
    }
    if (keep_pos < 0.001f && keep < 0.001f) correction_clear(c);
}

/* shown = raw with the correction */
static inline void correction_apply(const PuppetCorrection *c, const PuppetPose *raw, PuppetPose *out)
{
    PuppetPose r = *raw;
    for (int k = 0; k < 3; k++) out->pos[k] = r.pos[k] + (c->on ? c->pos[k] : 0);
    for (int i = 0; i < 3; i++) {
        for (int k = 0; k < 3; k++)
            out->rot[i][k] = c->on ? c->rot[i][0] * r.rot[0][k] + c->rot[i][1] * r.rot[1][k] + c->rot[i][2] * r.rot[2][k]
                                   : r.rot[i][k];
        out->rot[i][3] = r.rot[i][3];
    }
}

/* ---- what a puppet shows (puppet.c's wanted and smooth) ---- */

/* A snapshot's motion: its moment on this PC's race clock, its pose and velocities, its crash bit. */
typedef struct PuppetMotion {
    double time;
    float pos[3], rot[3][4], vel[3], spin[3];
    int crash;
} PuppetMotion;

/* How far (s) a snapshot h seconds old is carried: h up to carry; then the velocity fades (coast),
   the rider slowing rather than stopping dead; from coast_max the pose is held. */
static inline double carry_horizon(double h, const PuppetTune *k)
{
    if (!(h > 0)) return 0;
    if (h <= k->carry) return h;
    if (!(k->coast > 0)) return k->carry;
    double past = fmin(h, fmax(k->carry, k->coast_max)) - k->carry;
    return k->carry + k->coast * (1 - exp(-past / k->coast));
}

/* The snapshot carried forward from its moment to t: position along the velocity, orientation by
   the angular velocity. Returns the moment shown. */
static inline double puppet_carry(const PuppetMotion *m, double t, const PuppetTune *k, PuppetPose *out)
{
    double h = carry_horizon(t - m->time, k);
    predict_pose(m->pos, m->rot, m->vel, m->spin, (float)h, out);
    return m->time + h;
}

/* What a puppet shows: the snapshot it is carried from, the fading correction from the last change
   of it, and when that was last decayed. */
typedef struct PuppetView {
    PuppetMotion basis;
    int have_basis;
    PuppetCorrection fix;
    double fixed_at;
    int snaps;         /* corrections too large to fade (a count, for the tests) */
} PuppetView;

/* raw: the newest snapshot carried to now (puppet_carry), changed in place to what is shown. When a
   newer snapshot moves the prediction, the rider is first shown where it was and the difference
   fades; a jump too large to be a misprediction (a respawn) and the first pose after a crash or a
   gap (have_basis 0) are shown at once. */
static inline void puppet_show(PuppetView *v, const PuppetTune *k, double now, const PuppetMotion *newest, PuppetPose *raw)
{
    PuppetPose was, old;
    correction_decay(&v->fix, (float)(now - v->fixed_at));
    v->fixed_at = now;
    if (!v->have_basis || (newest->crash ^ v->basis.crash) & 4)
        correction_clear(&v->fix);
    else if (newest->time != v->basis.time) {
        puppet_carry(&v->basis, now, k, &old);
        correction_apply(&v->fix, &old, &was);
        if (!correction_fade(&v->fix, &was, raw, k)) v->snaps++;
    }
    v->basis = *newest, v->have_basis = 1;
    correction_apply(&v->fix, raw, &was);
    *raw = was;
}
#endif
