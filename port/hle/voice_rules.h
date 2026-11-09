/* Voice chat's who-hears-whom (finding 183): the rules port/hle/online.c applies each frame, here
   on their own so port/host/test_voice.c checks the very code the game runs. Distances are the
   game's world units (about VOICE_UNITS_PER_METRE a metre: a rider at 38 mph moves about 91 a
   second, measured against the HUD's speedometer). */
#ifndef DHD_VOICE_RULES_H
#define DHD_VOICE_RULES_H

#define VOICE_UNITS_PER_METRE 5.35f
#define VOICE_HYSTERESIS 1.1f   /* one heard stays heard to 1.1 times the range: no cutting in and out */
#define VOICE_EDGE 0.15f        /* the level at the range (and in the hysteresis band beyond it) */

/* Within reach, by squared distance (no root): `heard` says whether it was heard the frame before. */
static inline int voice_in_range(float d2, float range, int heard)
{
    float keep = range * (heard ? VOICE_HYSTERESIS : 1.0f);
    return d2 <= keep * keep;
}

/* The level at a distance: full to a third of the range, then down to VOICE_EDGE at it (and
   beyond it, in the hysteresis band). */
static inline float voice_gain(float distance, float range)
{
    float near = range / 3;
    if (distance <= near) return 1;
    float t = (distance - near) / (range - near);
    return t >= 1 ? VOICE_EDGE : 1 - t * (1 - VOICE_EDGE);
}

/* Who hears whom in a race: a racer hears a racer by distance; anyone finished (or watching) hears
   everyone and is heard by everyone at full level, wherever they are. 1 by distance, 2 at full
   level (voice chat works anywhere, this fork: the lobby and the race room hear everyone too). */
static inline int voice_group(int listener_finished, int speaker_finished)
{
    return listener_finished || speaker_finished ? 2 : 1;
}

#endif
