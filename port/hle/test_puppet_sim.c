/* A puppet on a simulated link (finding 210): a rider's true path, its snapshots sent through a
   link with delay, jitter, loss and Cloudflare's ~1 s stalls, and the viewer's frames running
   puppet_predict.h as puppet.c does (puppet_carry, puppet_show). Each
   frame the pose shown is scored against where the rider really is at that moment.

   As a test (no arguments) it checks the tuning puppet.c uses (PUPPET_TUNE) against findings 169
   and 202's (carried at full speed up to the snapshots' usual age plus 50 ms, 250-600 ms, then
   held; a correction 1/e in 80 ms, a jump over 8 units shown at once): about as close, and no more
   jumps or freezes, on every link. With arguments it prints the table for a tuning, to compare:
     test_puppet_sim before
     test_puppet_sim carry coast coast_max tau fade_speed snap rot_snap   ("-": PUPPET_TUNE's)

   The path (game units; a rider moves about 95 a second, puppet_lag.py): speed and turn rate wander
   (Ornstein-Uhlenbeck), the ground has bumps, kickers throw the rider into the air (gravity, a
   360-degree spin trick on half of them), and a crash every 20-40 s ends in a respawn 40 units back.
   The link: one-way age plus exponential jitter, delay spikes (+50-150 ms for 300 ms every ~10 s),
   loss; a browser (ordered: Cloudflare forwards a channel ordered and reliable, finding 173) holds
   every later snapshot behind a lost one until its resend (85% after 20-100 ms, 4% after
   100-500 ms, 11% after ~1 s, finding 173's counts), and some links add a forced stall. */
#include "puppet_predict.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

/* ---- random ---- */
static uint64_t rng = 1;
static double uni(void)
{
    rng ^= rng >> 12, rng ^= rng << 25, rng ^= rng >> 27;
    return ((rng * 2685821657736338717ull) >> 11) * (1.0 / 9007199254740992.0);
}
static double gauss(void) { return sqrt(-2 * log(uni() + 1e-300)) * cos(6.283185307179586 * uni()); }
static double expo(double mean) { return -mean * log(uni() + 1e-300); }

/* ---- the true path, every STEP seconds ---- */
#define STEP (1.0 / 240)
#define SECONDS 240
enum { STEPS = (int)(SECONDS / STEP) + 2 };
#define GRAVITY 110.0f   /* units/s^2 (a rider of ~95 units/s; 1 unit about 0.09 m) */

typedef struct Truth {
    float pos[3], vel[3], spin[3];
    float yaw;           /* the rider's heading, its orientation */
    int crash;           /* bit 2 */
} Truth;
static Truth path[STEPS];

static float ground(double s) { return (float)(-0.3 * s + 1.5 * sin(s / 13) + 0.8 * sin(s / 5.3 + 1)); }
static float slope(double s) { return (float)(-0.3 + 1.5 / 13 * cos(s / 13) + 0.8 / 5.3 * cos(s / 5.3 + 1)); }

static void make_path(void)
{
    double x = 0, z = 0, s = 0, y = ground(0), vy = 0, travel = 0, trick = 0, trick_rate = 0;
    double v = 90, w = 0, next_kick = 3 + 6 * uni(), next_crash = 15 + 20 * uni(), crash_end = -1;
    int air = 0;
    for (int i = 0; i < STEPS; i++) {
        double t = i * STEP;
        if (crash_end < 0 && t >= next_crash && !air) crash_end = t + 3;
        if (crash_end >= 0 && t >= crash_end) {  /* the respawn: 40 units back, slow */
            x -= 40 * sin(travel), z -= 40 * cos(travel), s -= 40;
            y = ground(s), vy = 0, v = 10, w = 0, trick = 0, crash_end = -1;
            next_crash = t + 20 + 20 * uni();
        }
        int crashing = crash_end >= 0;
        if (crashing) v = fmax(0, v - 60 * STEP);
        else {
            /* speed wanders around 90 (2 s), a respawned rider picks up at 40 units/s^2 */
            double target = 90 + 15 * gauss() * 0.3;
            v += (target - v) * STEP / 2 + (v < 60 ? 40 * STEP : 0) + 25 * sqrt(STEP) * gauss() * 0.4;
            v = fmin(130, fmax(5, v));
            if (!air) w += -w * STEP / 0.7 + 0.5 * sqrt(2 * STEP / 0.7) * gauss();
        }
        travel += (air ? 0 : w) * STEP;
        x += v * sin(travel) * STEP, z += v * cos(travel) * STEP, s += v * STEP;
        if (!air && !crashing && t >= next_kick) {  /* a kicker */
            air = 1, vy = v * (0.25 + 0.2 * uni());
            double airtime = 2 * vy / GRAVITY;
            trick_rate = uni() < 0.5 ? (uni() < 0.5 ? 1 : -1) * 6.283185307179586 / airtime : 0;
            next_kick = t + 4 + 6 * uni();
        }
        if (air) {
            vy -= GRAVITY * STEP, y += vy * STEP, trick += trick_rate * STEP;
            if (y <= ground(s)) air = 0, y = ground(s), trick = 0, trick_rate = 0;
        } else
            y = ground(s), vy = slope(s) * v;
        Truth *p = &path[i];
        p->pos[0] = (float)x, p->pos[1] = (float)y, p->pos[2] = (float)z;
        p->vel[0] = (float)(v * sin(travel)), p->vel[1] = (float)vy, p->vel[2] = (float)(v * cos(travel));
        p->yaw = (float)(travel + trick);
        p->spin[0] = 0, p->spin[1] = (float)((air ? 0 : w) + (air ? trick_rate : 0)), p->spin[2] = 0;
        p->crash = crashing ? 4 : 0;
    }
}

/* rows for heading a about y (as test_puppet_predict.c): row 2 is the rider's forward axis */
static void heading(float a, float rot[3][4])
{
    memset(rot, 0, 12 * sizeof(float));
    rot[0][0] = cosf(a), rot[0][2] = -sinf(a);
    rot[1][1] = 1;
    rot[2][0] = sinf(a), rot[2][2] = cosf(a);
}

static void truth_at(double t, float pos[3], float *yaw, int *crash)
{
    int i = (int)(t / STEP);
    if (i < 0) i = 0;
    if (i >= STEPS - 1) i = STEPS - 2;
    float f = (float)(t / STEP - i);
    for (int k = 0; k < 3; k++) pos[k] = path[i].pos[k] + (path[i + 1].pos[k] - path[i].pos[k]) * f;
    *yaw = path[i].yaw;
    *crash = path[i].crash | path[i + 1].crash;
}

/* ---- the link ---- */
typedef struct Link {
    const char *name;
    double rate;         /* snapshots a second */
    double age, jitter;  /* s: one way, and the mean of its exponential extra */
    double loss;
    int ordered;         /* a browser: Cloudflare's reliable ordered forwarding */
    double stall_every, stall;  /* s: a forced stall of this long every so often (0: none) */
    double fps;          /* the viewer's frame rate */
} Link;

typedef struct Sent { double time, deliver; int step; } Sent;
static Sent sent[SECONDS * 60 + 8];

static int send_all(const Link *l)
{
    int n = 0;
    double last = 0, spike_at = 5 + expo(10), stall_at = l->stall_every > 0 ? 10 + l->stall_every * uni() : 1e9;
    for (double t = 0; t < SECONDS - 1; t += 1 / l->rate) {
        double d = l->age + expo(l->jitter);
        if (t >= spike_at && t < spike_at + 0.3) d += 0.05 + 0.1 * uni();
        if (t >= spike_at + 0.3) spike_at = t + expo(10);
        double at = t + d;
        if (uni() < l->loss) {
            if (!l->ordered) continue;  /* unordered, no resend: gone */
            double u = uni();
            at += u < 0.85 ? 0.02 + 0.08 * uni() : u < 0.89 ? 0.1 + 0.4 * uni() : 1.0 + 0.016 * uni();
        }
        if (t >= stall_at) {
            if (t < stall_at + l->stall) at = fmax(at, stall_at + l->stall + l->age);
            else stall_at = t + l->stall_every * (0.5 + uni());
        }
        if (l->ordered) at = fmax(at, last);
        last = fmax(last, at);
        sent[n].time = t, sent[n].deliver = at, sent[n].step = (int)(t / STEP + 0.5);
        n++;
    }
    /* in delivery order (stable: equal times keep sending order) */
    for (int i = 1; i < n; i++)
        for (int j = i; j > 0 && sent[j].deliver < sent[j - 1].deliver; j--) {
            Sent s = sent[j];
            sent[j] = sent[j - 1], sent[j - 1] = s;
        }
    return n;
}

/* ---- the viewer and the score ---- */
typedef struct Score {
    double frames, err_sum, err_p95, err_p99, err_max, ang_sum, ang_p95, minutes;
    double jerks, jumps, freeze, snaps;
} Score;

static int by_float(const void *a, const void *b) { float x = *(const float *)a, y = *(const float *)b; return (x > y) - (x < y); }
static float errs[SECONDS * 300], angs[SECONDS * 300];

/* findings 169 and 202's limit: the snapshots' usual age (puppet.c's estimate) plus 50 ms, 250-600 ms */
typedef struct Age { int have; double age; } Age;
static void age_feed(Age *a, double age)
{
    if (!a->have) a->age = age, a->have = 1;
    else {
        a->age += (age - a->age) / 16;
        if (a->have < 1000) a->have++;
        if (a->have == 16) a->age = age;
    }
}
static double age_limit(const Age *a) { return fmin(0.6, fmax(0.25, a->have >= 16 ? a->age + 0.05 : 0)); }

/* puppet.c's feed, wanted, smooth and hle_puppet_physics's crash, frame by frame; by_age: carry as
   far as age_limit says (findings 169, 202) */
static Score run(const Link *l, const PuppetTune *tune, int by_age, uint64_t seed)
{
    PuppetTune kk = *tune, *k = &kk;
    Score sc;
    memset(&sc, 0, sizeof sc);
    rng = seed;
    make_path();
    int n = send_all(l), next = 0, have = 0, nerr = 0, prev_ok = 0, local_crash = 0;
    Age age;
    PuppetView view;
    PuppetMotion newest;
    memset(&age, 0, sizeof age);
    memset(&view, 0, sizeof view);
    correction_clear(&view.fix);
    float shown_prev[3] = {0}, true_prev[3] = {0};
    double prev_t = 0;
    for (double now = 0.5; now < SECONDS - 2; now += (1 + 0.05 * gauss()) / l->fps) {
        while (next < n && sent[next].deliver <= now) {
            const Sent *s = &sent[next++];
            if (have && s->time <= newest.time) continue;  /* older than the newest: dropped */
            age_feed(&age, now - s->time);
            const Truth *p = &path[s->step];
            newest.time = s->time;
            memcpy(newest.pos, p->pos, sizeof newest.pos);
            heading(p->yaw, newest.rot);
            memcpy(newest.vel, p->vel, sizeof newest.vel);
            memcpy(newest.spin, p->spin, sizeof newest.spin);
            newest.crash = p->crash;
            have = 1;
        }
        if (!have) continue;
        /* The crash: the game runs it here from its start to the respawn, and the rider is then
           shown at its snapshot at once (hle_puppet_physics) */
        if (newest.crash & 4) local_crash = 1;
        if (local_crash) {
            if (newest.crash & 4) { view.have_basis = 0, prev_ok = 0; continue; }
            local_crash = 0;
        }
        if (by_age) k->carry = age_limit(&age);
        PuppetPose shown;
        if (now >= newest.time) puppet_carry(&newest, now, k, &shown);
        else memcpy(shown.pos, newest.pos, sizeof shown.pos), memcpy(shown.rot, newest.rot, sizeof shown.rot);
        int first = !view.have_basis;
        puppet_show(&view, k, now, &newest, &shown);

        float real[3], yaw;
        int crash;
        truth_at(now, real, &yaw, &crash);
        if (crash || first || now < 3) { prev_ok = 0; continue; }  /* the crash is the game's; the respawn shows at once */
        float d2 = 0;
        for (int i = 0; i < 3; i++) d2 += (shown.pos[i] - real[i]) * (shown.pos[i] - real[i]);
        float e = sqrtf(d2), dot = shown.rot[2][0] * sinf(yaw) + shown.rot[2][2] * cosf(yaw);
        float ang = acosf(fminf(1, fmaxf(-1, dot))) * 57.29578f;
        errs[nerr] = e, angs[nerr++] = ang;
        sc.err_sum += e, sc.ang_sum += ang, sc.err_max = fmaxf((float)sc.err_max, e);
        if (prev_ok) {
            double dt = now - prev_t, ss = 0, st = 0, dd = 0;
            for (int i = 0; i < 3; i++) {
                double a = shown.pos[i] - shown_prev[i], b = real[i] - true_prev[i];
                ss += a * a, st += b * b, dd += (a - b) * (a - b);
            }
            ss = sqrt(ss) / dt, st = sqrt(st) / dt, dd = sqrt(dd) / dt;
            if (fabs(ss - st) > 30) sc.jerks++;          /* puppet_lag.py's jerk: drawn speed off by 30 */
            if (dd > 300) sc.jumps++;                    /* a visible jump: 5 units in a 60 fps frame */
            if (st > 30 && ss < 0.3 * st) sc.freeze += dt;  /* drawn (nearly) still while it moves */
        }
        memcpy(shown_prev, shown.pos, sizeof shown_prev);
        memcpy(true_prev, real, sizeof true_prev);
        prev_t = now, prev_ok = 1;
    }
    qsort(errs, nerr, sizeof *errs, by_float);
    qsort(angs, nerr, sizeof *angs, by_float);
    sc.frames = nerr;
    sc.minutes = nerr / l->fps / 60;
    sc.err_p95 = errs[(int)(nerr * 0.95)], sc.err_p99 = errs[(int)(nerr * 0.99)], sc.ang_p95 = angs[(int)(nerr * 0.95)];
    sc.snaps = view.snaps;
    return sc;
}

static const Link links[] = {
    /* name                     rate  age    jitter  loss  ord  stall_every stall  fps */
    {"near, native, 1% loss",   60, 0.030, 0.005, 0.01, 0, 0, 0, 60},
    {"India, native, 2% loss",  60, 0.110, 0.012, 0.02, 0, 0, 0, 60},
    {"India, browser, 1% loss", 60, 0.110, 0.012, 0.01, 1, 0, 0, 60},
    {"India, browser, 2% loss", 60, 0.125, 0.015, 0.02, 1, 0, 0, 60},
    {"India, browser, 1 s stalls", 60, 0.125, 0.015, 0.01, 1, 15, 1.0, 60},
    {"India, AI rider (30/s)",  30, 0.125, 0.015, 0.02, 1, 0, 0, 60},
    {"relay race, 250 ms",      60, 0.250, 0.025, 0.00, 1, 0, 0, 60},
    {"India, browser, 144 fps", 60, 0.125, 0.015, 0.02, 1, 0, 0, 144},
};
enum { NLINKS = sizeof links / sizeof *links, SEEDS = 6 };

static Score total(const Link *l, const PuppetTune *k, int by_age)
{
    Score t;
    memset(&t, 0, sizeof t);
    for (int s = 0; s < SEEDS; s++) {
        Score r = run(l, k, by_age, 0x9E3779B97F4A7C15ull * (s + 1));
        t.frames += r.frames, t.minutes += r.minutes, t.err_sum += r.err_sum, t.ang_sum += r.ang_sum;
        t.err_p95 += r.err_p95 / SEEDS, t.err_p99 += r.err_p99 / SEEDS, t.ang_p95 += r.ang_p95 / SEEDS;
        t.err_max = fmax(t.err_max, r.err_max);
        t.jerks += r.jerks, t.jumps += r.jumps, t.freeze += r.freeze, t.snaps += r.snaps;
    }
    return t;
}

static void print(const char *name, const Score *s)
{
    printf("%-28s %6.2f %6.2f %6.2f %7.1f %5.2f %5.1f %7.1f %6.2f %6.2f %5.2f\n", name, s->err_sum / s->frames, s->err_p95,
           s->err_p99, s->err_max, s->ang_sum / s->frames, s->ang_p95, s->jerks / s->minutes, s->jumps / s->minutes,
           s->freeze / s->minutes, s->snaps / s->minutes);
}

static void table(const PuppetTune *k, int by_age)
{
    printf("%-28s %6s %6s %6s %7s %5s %5s %7s %6s %6s %5s\n", "link", "err", "p95", "p99", "max", "deg", "p95",
           "jerk/m", "jump/m", "frz s/m", "snap/m");
    for (int i = 0; i < NLINKS; i++) {
        Score s = total(&links[i], k, by_age);
        print(links[i].name, &s);
    }
}

int main(int argc, char **argv)
{
    static const PuppetTune now = PUPPET_TUNE, before = {0.25, 0, 0, 0.08f, 0, 8, 180};  /* findings 169, 202 */
    if (argc > 1) {
        PuppetTune k = now;
        int by_age = !strcmp(argv[1], "before");
        double *d[] = {&k.carry, &k.coast, &k.coast_max};
        float *f[] = {&k.tau, &k.fade_speed, &k.snap, &k.rot_snap};
        if (by_age) k = before;
        else
            for (int i = 1; i < argc && i <= 7; i++)
                if (strcmp(argv[i], "-")) i <= 3 ? (*d[i - 1] = atof(argv[i])) : (*f[i - 4] = (float)atof(argv[i]));
        if (by_age) printf("before: carried the usual age + 50 ms (250-600 ms), then held; tau 0.080, snap 8\n");
        else
            printf("carry %.2f, coast %.2f to %.2f, tau %.3f, fade %.0f/s, snap %.0f, turn snap %.0f\n", k.carry, k.coast,
                   k.coast_max, k.tau, k.fade_speed, k.snap, k.rot_snap);
        table(&k, by_age);
        return 0;
    }
    for (int i = 0; i < NLINKS; i++) {
        Score a = total(&links[i], &before, 1), b = total(&links[i], &now, 0);
        print(links[i].name, &b);
        assert(b.err_sum / b.frames <= a.err_sum / a.frames * 1.02);  /* about as close on average */
        assert(b.err_p99 <= a.err_p99 * 1.1);  /* a kicker's misprediction now fades instead of jumping */
        assert(b.ang_sum / b.frames <= a.ang_sum / a.frames * 1.02);
        assert(b.jumps <= a.jumps && b.freeze <= a.freeze + 0.01 * a.minutes);
        /* and the jumps and freezes the browser's stalls made are (nearly) gone */
        assert(b.jumps / b.minutes < 1 && b.freeze / b.minutes < 0.1);
    }
    puts("puppet on simulated links: OK");
    return 0;
}
