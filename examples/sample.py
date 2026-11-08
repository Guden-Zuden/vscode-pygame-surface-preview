import pygame as pg

pg.init()

surface = pg.Surface((240, 160), pg.SRCALPHA)
surface.fill((220, 40, 50, 255))

# Set a breakpoint on this line, start debugging, then hover over `surface`.
print(surface.get_size())
