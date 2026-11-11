/* The puppet predictor (puppet_predict.h, findings 169, 210): a straight line, a turn, a correction
   that starts where the rider was shown and fades, a large one that fades slower, a large turn and a
   teleport that snap, and the carry through a stall. */
#include "puppet_predict.h"
#include <assert.h>
#include <stdio.h>

static int near(float a, float b, float eps) { return fabsf(a - b) <= eps; }

/* the rider's rows for heading a (radians) about the world y axis */
static void heading(float a, float rot[3][4])
{
    memset(rot, 0, 12 * sizeof(float));
    rot[0][0] = cosf(a), rot[0][2] = -sinf(a);
    rot[1][1] = 1;
    rot[2][0] = sinf(a), rot[2][2] = cosf(a);
}

int main(void)
{
    static const PuppetTune k = PUPPET_TUNE;
    PuppetPose out, was, shown;
    float pos[3] = {10, 2, -5}, vel[3] = {30, -1, 4}, still[3] = {0, 0, 0}, rot[3][4];

    /* straight on: position along the velocity, orientation unchanged */
    heading(0.3f, rot);
    predict_pose(pos, rot, vel, still, 0.05f, &out);
    assert(near(out.pos[0], 11.5f, 1e-4f) && near(out.pos[1], 1.95f, 1e-4f) && near(out.pos[2], -4.8f, 1e-4f));
    for (int i = 0; i < 3; i++)
        for (int k = 0; k < 3; k++) assert(near(out.rot[i][k], rot[i][k], 1e-6f));

    /* a turn at 2 rad/s about y: after 0.1 s every row has turned 0.2 rad, as the heading would */
    {
        float spin[3] = {0, 2, 0}, want[3][4];
        PuppetPose a;
        heading(0.3f, rot);
        predict_pose(pos, rot, vel, spin, 0.1f, &a);
        heading(0.3f + 0.2f, want);
        int same = 1, mirrored = 1;
        heading(0.3f - 0.2f, rot);  /* the other sense, to be sure the test tells them apart */
        for (int i = 0; i < 3; i++)
            for (int k = 0; k < 3; k++) {
                same &= near(a.rot[i][k], want[i][k], 1e-4f);
                mirrored &= near(a.rot[i][k], rot[i][k], 1e-4f);
            }
        assert(same && !mirrored);
        /* rows stay orthonormal */
        for (int i = 0; i < 3; i++)
            for (int j = 0; j < 3; j++) {
                float d = a.rot[i][0] * a.rot[j][0] + a.rot[i][1] * a.rot[j][1] + a.rot[i][2] * a.rot[j][2];
                assert(near(d, i == j, 1e-5f));
            }
    }

    /* a correction: a newer snapshot moved the prediction 0.6 units and 0.1 rad; the rider is shown
       where it was, then fades to the new prediction */
    {
        PuppetCorrection c;
        heading(0.0f, rot);
        predict_pose(pos, rot, vel, still, 0, &was);
        float moved[3] = {pos[0] + 0.6f, pos[1], pos[2]};
        heading(0.1f, rot);
        PuppetPose raw;
        predict_pose(moved, rot, vel, still, 0, &raw);
        correction_clear(&c);
        assert(correction_fade(&c, &was, &raw, &k));
        correction_apply(&c, &raw, &shown);
        for (int k = 0; k < 3; k++) assert(near(shown.pos[k], was.pos[k], 1e-4f));
        for (int i = 0; i < 3; i++)
            for (int k = 0; k < 3; k++) assert(near(shown.rot[i][k], was.rot[i][k], 1e-4f));
        float before = 0.6f;
        for (int step = 0; step < 30; step++) {  /* half a second at 60 */
            correction_decay(&c, 1 / 60.0f);
            correction_apply(&c, &raw, &shown);
            float off = fabsf(shown.pos[0] - raw.pos[0]);
            assert(off <= before + 1e-6f);
            before = off;
        }
        assert(before < 0.6f * 0.01f && near(c.tau, k.tau, 1e-6f));  /* small: exp(-0.5/0.08) */
        for (int i = 0; i < 3; i++)
            for (int k = 0; k < 3; k++) assert(near(shown.rot[i][k], raw.rot[i][k], 2e-3f));
    }

    /* a large difference (a kicker taken while its snapshots were on the way, a stall's end) fades
       slower: it starts no faster than fade_speed */
    {
        PuppetCorrection c;
        float off[3] = {pos[0] + 30, pos[1], pos[2]};
        PuppetPose raw;
        heading(0.0f, rot);
        predict_pose(pos, rot, vel, still, 0, &was);
        predict_pose(off, rot, vel, still, 0, &raw);
        correction_clear(&c);
        assert(correction_fade(&c, &was, &raw, &k) && near(c.tau, 30 / k.fade_speed, 1e-5f));
        correction_decay(&c, 1 / 60.0f);
        assert(30 - fabsf(c.pos[0]) <= k.fade_speed / 60 * 1.01f);  /* moved at most fade_speed in a frame */
    }

    /* a large turn (a trick's start or landing) is shown at once, the position still fades */
    {
        PuppetCorrection c;
        PuppetPose raw;
        heading(0.0f, rot);
        predict_pose(pos, rot, vel, still, 0, &was);
        heading(1.0f, rot);  /* 57 degrees */
        float moved[3] = {pos[0] + 1, pos[1], pos[2]};
        predict_pose(moved, rot, vel, still, 0, &raw);
        correction_clear(&c);
        assert(correction_fade(&c, &was, &raw, &k));
        correction_apply(&c, &raw, &shown);
        assert(near(shown.pos[0], was.pos[0], 1e-4f));
        for (int i = 0; i < 3; i++)
            for (int j = 0; j < 3; j++) assert(near(shown.rot[i][j], raw.rot[i][j], 1e-5f));
    }

    /* the carry: full speed for carry, then slowing (never past coast_max), never backwards */
    {
        double last = 0;
        assert(carry_horizon(-1, &k) == 0 && carry_horizon(0.1, &k) == 0.1 && carry_horizon(k.carry, &k) == k.carry);
        for (double h = 0; h < 5; h += 0.01) {
            double c = carry_horizon(h, &k);
            assert(c >= last - 1e-12 && c <= h + 1e-12);
            if (h > k.carry) assert(c - last <= 0.01 + 1e-9);
            last = c;
        }
        assert(near((float)carry_horizon(5, &k), (float)carry_horizon(k.coast_max, &k), 1e-6f));
    }

    /* a teleport: the snapshot jumps far away; nothing fades, the rider is shown there (a respawn
       after a crash is shown at once anyway: puppet_show starts afresh when the crash bit changes) */
    {
        PuppetCorrection c;
        float respawn[3] = {pos[0] - 80, pos[1] + 3, pos[2]};
        PuppetPose raw;
        heading(0.0f, rot);
        predict_pose(pos, rot, vel, still, 0, &was);
        predict_pose(respawn, rot, still, still, 0, &raw);
        correction_clear(&c);
        assert(!correction_fade(&c, &was, &raw, &k) && !c.on);
        correction_apply(&c, &raw, &shown);
        for (int k = 0; k < 3; k++) assert(shown.pos[k] == raw.pos[k]);
    }

    /* no spin and a zero or bad horizon change nothing */
    {
        float bad[3] = {NAN, 0, 0};
        heading(0.7f, rot);
        predict_pose(pos, rot, still, bad, 0.1f, &out);
        for (int i = 0; i < 3; i++)
            for (int k = 0; k < 3; k++) assert(out.rot[i][k] == rot[i][k]);
    }
    puts("puppet prediction: OK");
    return 0;
}
